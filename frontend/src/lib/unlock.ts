import {
  createPromitFetch,
  verifyContentHash,
  SessionCapExceededError,
  SpendLedgerCorruptError,
  type ClientEvmSigner,
  type ContentHashCheck,
  type FetchLike,
  type SpendLedger,
} from "@promit/x402-client";

import { promptUrl } from "./api";

/**
 * The browser side of the shared payment client (U6, KTD19). Everything
 * safety-critical — the policy filter, the cap comparison, the
 * charge-before-signature ordering, the content-hash rule — is imported from
 * `@promit/x402-client`; this module only supplies what a browser cannot get
 * from the package: a Storage-backed spend ledger (the package's file ledger
 * needs node:fs) and a signer bridged from wagmi.
 */

const SPEND_KEY = "promit.session.spentAtomic";

/**
 * Session spend ledger persisted in `sessionStorage`, satisfying the surface
 * `createPromitFetch` calls (`spent`/`charge`/`refund`). Same semantics as
 * the package's file ledger: the cap re-check inside `charge` is the
 * enforcement point, refund never goes below zero, and a value that exists
 * but cannot be parsed fails CLOSED (`SpendLedgerCorruptError`) — treating a
 * scribbled-on ledger as zero would reset the budget.
 */
export function createBrowserSpendLedger(storage?: Storage): SpendLedger {
  // Private windows can throw on any storage access; spend then still counts
  // for the lifetime of this ledger via the in-memory shadow.
  let memory = 0n;
  const store = (() => {
    try {
      return storage ?? window.sessionStorage;
    } catch {
      return null;
    }
  })();

  const read = (): bigint => {
    if (!store) return memory;
    let raw: string | null;
    try {
      raw = store.getItem(SPEND_KEY);
    } catch {
      return memory;
    }
    if (raw === null) return 0n;
    if (!/^\d+$/.test(raw)) {
      throw new SpendLedgerCorruptError(SPEND_KEY, "spentAtomic is not a non-negative integer string");
    }
    return BigInt(raw);
  };
  const write = (next: bigint): void => {
    memory = next;
    try {
      store?.setItem(SPEND_KEY, next.toString());
    } catch {
      // Storage refused the write; the in-memory shadow keeps counting.
    }
  };

  const ledger: Pick<SpendLedger, "spent" | "charge" | "refund" | "reset"> = {
    spent: () => read(),
    charge(amountAtomic: bigint, sessionCapAtomic: bigint): bigint {
      if (amountAtomic < 0n) {
        throw new RangeError(`cannot charge a negative amount: ${amountAtomic}`);
      }
      const spent = read();
      const next = spent + amountAtomic;
      if (next > sessionCapAtomic) {
        throw new SessionCapExceededError(amountAtomic, spent, sessionCapAtomic);
      }
      write(next);
      return next;
    },
    refund(amountAtomic: bigint): bigint {
      if (amountAtomic < 0n) {
        throw new RangeError(`cannot refund a negative amount: ${amountAtomic}`);
      }
      const spent = read();
      const next = spent > amountAtomic ? spent - amountAtomic : 0n;
      write(next);
      return next;
    },
    reset(): void {
      write(0n);
    },
  };
  // SpendLedger's private members make the class type nominal; the client
  // only ever touches the public surface implemented above.
  return ledger as SpendLedger;
}

let sharedLedger: SpendLedger | null = null;
/** One ledger per tab session, so consecutive unlocks share the session cap. */
export function sessionLedger(): SpendLedger {
  sharedLedger ??= createBrowserSpendLedger();
  return sharedLedger;
}

type TypedDataPayload = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

/**
 * Bridges a wagmi wallet to the shared client's `ClientEvmSigner`: the
 * client only needs an address plus `signTypedData`, so the adapter is a
 * plain object. `signTypedData` here is wagmi's `signTypedDataAsync` (or the
 * core action) — the wallet signs EIP-712 typed data; no transaction is ever
 * built or broadcast on this path.
 */
export function wagmiClientSigner(
  address: `0x${string}`,
  signTypedData: (payload: TypedDataPayload) => Promise<`0x${string}`>,
): ClientEvmSigner {
  return {
    address,
    signTypedData: (payload) => signTypedData(payload),
  };
}

/** The user declined the wallet's signature request. Not a failure — idle. */
export class SignatureRejectedError extends Error {
  constructor() {
    super("The signature request was declined in the wallet. Nothing was signed and nothing was spent.");
    this.name = "SignatureRejectedError";
  }
}

/** The server refused the unlock after (or instead of) payment. */
export class UnlockFailedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "UnlockFailedError";
  }
}

/** Walks the cause chain for EIP-1193 code 4001 / viem's rejection error. */
function isUserRejection(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause as Error) {
    const candidate = current as Error & { code?: unknown };
    if (candidate.code === 4001 || candidate.name === "UserRejectedRequestError") {
      return true;
    }
  }
  return false;
}

export interface UnlockRequest {
  promptId: string;
  /** Catalog hash shown BEFORE purchase — the content the buyer agreed to. */
  advertisedContentHash: string;
  /**
   * Advertised atomic USDC price, used as the per-prompt cap: the buyer
   * consented to exactly this number, so a 402 demanding more is refused by
   * the shared policy filter before any signature.
   */
  priceAtomic: string;
  signer: ClientEvmSigner;
  /** Fires once the wallet returned a signature — verify+settle begins. */
  onSigned?: () => void;
  /** Defaults to the tab-wide {@link sessionLedger}. Tests inject. */
  ledger?: SpendLedger;
  /** Base fetch, injectable for tests. */
  fetch?: FetchLike;
}

export interface UnlockedPrompt {
  text: string;
  txHash: string;
  network: string;
  payer: string;
  /** Delivered text checked against the hash advertised before purchase. */
  hashCheck: ContentHashCheck;
  /** Hash the server reported alongside the text (should match advertised). */
  responseContentHash: string;
}

interface UnlockResponseBody {
  id?: string;
  tier?: string;
  text?: string;
  contentHash?: string;
  txHash?: string;
  network?: string;
  payer?: string;
  error?: string;
  message?: string;
}

/**
 * One paid unlock through the shared client. Throws before any signature for
 * policy/cap refusals (`PaymentRefusedError` family, straight from the
 * package), {@link SignatureRejectedError} when the user declines in the
 * wallet, and {@link UnlockFailedError} when the server answers non-OK after
 * the payment attempt (settle failure, indeterminate settlement, …).
 *
 * A content-hash mismatch does NOT throw: the caller gets the delivered text
 * plus the failed {@link ContentHashCheck} so the mismatch can be shown
 * prominently next to what was actually delivered.
 */
export async function unlockPrompt(request: UnlockRequest): Promise<UnlockedPrompt> {
  // The wrapper re-wraps downstream errors into plain `Error`s, so a wallet
  // rejection is recorded at the signer seam where it is still recognizable.
  let rejectedInWallet = false;
  const signer: ClientEvmSigner = {
    address: request.signer.address,
    async signTypedData(payload) {
      let signature: `0x${string}`;
      try {
        signature = await request.signer.signTypedData(payload);
      } catch (error) {
        rejectedInWallet = isUserRejection(error);
        throw error;
      }
      request.onSigned?.();
      return signature;
    },
  };

  const { fetchWithPayment } = createPromitFetch({
    signer,
    ledger: request.ledger ?? sessionLedger(),
    perPromptCapAtomic: BigInt(request.priceAtomic),
    fetch: request.fetch,
  });

  let response: Response;
  try {
    response = await fetchWithPayment(promptUrl(request.promptId), {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (rejectedInWallet) throw new SignatureRejectedError();
    throw error;
  }

  let body: UnlockResponseBody = {};
  try {
    body = (await response.json()) as UnlockResponseBody;
  } catch {
    // Non-JSON answers fall through to the status checks below.
  }

  if (!response.ok) {
    throw new UnlockFailedError(
      response.status,
      body.error,
      body.message ?? `The unlock failed with HTTP ${response.status}.`,
    );
  }
  if (typeof body.text !== "string" || typeof body.txHash !== "string") {
    throw new UnlockFailedError(
      response.status,
      body.error,
      "The server answered OK but sent no prompt text or transaction hash.",
    );
  }

  return {
    text: body.text,
    txHash: body.txHash,
    network: body.network ?? "",
    payer: body.payer ?? "",
    hashCheck: verifyContentHash(body.text, request.advertisedContentHash),
    responseContentHash: body.contentHash ?? "",
  };
}
