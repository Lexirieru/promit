import { afterEach, describe, expect, test, vi } from "vitest";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import {
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  PerPromptCapExceededError,
  SessionCapExceededError,
  SpendLedgerCorruptError,
  hashPromptText,
  type ClientEvmSigner,
} from "@promit/x402-client";

import {
  SignatureRejectedError,
  UnlockFailedError,
  createBrowserSpendLedger,
  unlockPrompt,
} from "@/lib/unlock";

/**
 * U6's bridge exercised against the REAL shared-client machinery: real
 * policy filter, real payment wrapper, real hash rule. Only the wallet
 * (mock signer) and the server (fetch stub speaking x402 v2 headers plus
 * the locked U4 response contract) are fakes.
 */

const PAY_TO = "0x2222222222222222222222222222222222222222";
const PROMPT_ID = "paid-prompt";
const PROMPT_TEXT = "Design a cinematic hero section.\nUse restraint.";
const PRICE_ATOMIC = "500000";
const TX_HASH = `0x${"11".repeat(32)}`;
const PAYER = "0x1111111111111111111111111111111111111111";

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    asset: BASE_SEPOLIA_USDC,
    amount: PRICE_ATOMIC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

type SignedPayload = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

function recordingSigner(behavior?: () => never): {
  signer: ClientEvmSigner;
  payloads: SignedPayload[];
} {
  const payloads: SignedPayload[] = [];
  return {
    payloads,
    signer: {
      address: PAYER,
      async signTypedData(payload) {
        if (behavior) behavior();
        payloads.push(payload as SignedPayload);
        return `0x${"ab".repeat(65)}` as `0x${string}`;
      },
    },
  };
}

/** In-memory Storage so ledger tests never touch jsdom's shared sessionStorage. */
class FakeStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

/**
 * Fake unlock endpoint: 402 with a v2 PAYMENT-REQUIRED header until a
 * PAYMENT-SIGNATURE arrives, then the configured settled answer — by
 * default the locked U4 success body (text, contentHash, txHash).
 */
function fakeUnlockServer(
  accepts: PaymentRequirements[],
  settled?: () => Response,
) {
  const paid: Request[] = [];
  const fetchMock = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input as Request | string, init);
    if (!request.headers.has("PAYMENT-SIGNATURE")) {
      return new Response(JSON.stringify({ error: "payment_required", message: "Payment required." }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: request.url },
            accepts,
          }),
        },
      });
    }
    paid.push(request);
    if (settled) return settled();
    return new Response(
      JSON.stringify({
        id: PROMPT_ID,
        tier: "paid",
        text: PROMPT_TEXT,
        contentHash: hashPromptText(PROMPT_TEXT),
        txHash: TX_HASH,
        network: BASE_SEPOLIA_NETWORK,
        payer: PAYER,
        attribution: { source: "motionsites.ai", capturedAt: "2026-08-06", note: "seed" },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction: TX_HASH,
            network: BASE_SEPOLIA_NETWORK,
            payer: PAYER,
          }),
        },
      },
    );
  };
  return { fetchMock, paid };
}

function baseRequest(signer: ClientEvmSigner, fetchMock: typeof fetch | ((i: Request | string | URL, init?: RequestInit) => Promise<Response>)) {
  return {
    promptId: PROMPT_ID,
    advertisedContentHash: hashPromptText(PROMPT_TEXT),
    priceAtomic: PRICE_ATOMIC,
    signer,
    ledger: createBrowserSpendLedger(new FakeStorage()),
    fetch: fetchMock as typeof fetch,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unlockPrompt against the real payment machinery", () => {
  test("a successful unlock returns text and tx hash, the hash check passes, and the spend is recorded", async () => {
    const { signer, payloads } = recordingSigner();
    const { fetchMock, paid } = fakeUnlockServer([requirement()]);
    const events: string[] = [];

    const request = baseRequest(signer, fetchMock);
    const result = await unlockPrompt({ ...request, onSigned: () => events.push("signed") });

    expect(result.text).toBe(PROMPT_TEXT);
    expect(result.txHash).toBe(TX_HASH);
    expect(result.network).toBe(BASE_SEPOLIA_NETWORK);
    expect(result.payer).toBe(PAYER);
    expect(result.hashCheck.ok).toBe(true);
    expect(events).toEqual(["signed"]);
    expect(paid).toHaveLength(1);
    expect(request.ledger.spent()).toBe(BigInt(PRICE_ATOMIC));
    expect(payloads).toHaveLength(1);
  });

  test("the signing request is EIP-712 typed data, never a transaction", async () => {
    const { signer, payloads } = recordingSigner();
    const { fetchMock } = fakeUnlockServer([requirement()]);

    await unlockPrompt(baseRequest(signer, fetchMock));

    // The signer exposes signTypedData ONLY - no signTransaction, no
    // sendTransaction - and the flow completed with exactly one typed-data
    // signature carrying the four EIP-712 fields.
    expect(payloads).toHaveLength(1);
    const payload = payloads[0]!;
    expect(payload.domain).toMatchObject({ name: "USDC", version: "2" });
    expect(typeof payload.primaryType).toBe("string");
    expect(payload.types).toHaveProperty(payload.primaryType);
    expect(payload.message).toBeTruthy();
  });

  test("tampered text comes back with a FAILED hash check instead of a silent success or a throw", async () => {
    const { signer } = recordingSigner();
    const advertised = hashPromptText(PROMPT_TEXT);
    const { fetchMock } = fakeUnlockServer(
      [requirement()],
      () =>
        new Response(
          JSON.stringify({
            id: PROMPT_ID,
            tier: "paid",
            text: "TAMPERED BODY",
            contentHash: advertised,
            txHash: TX_HASH,
            network: BASE_SEPOLIA_NETWORK,
            payer: PAYER,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await unlockPrompt({ ...baseRequest(signer, fetchMock), advertisedContentHash: advertised });

    expect(result.hashCheck.ok).toBe(false);
    expect(result.hashCheck.expectedHash).toBe(advertised);
    expect(result.hashCheck.actualHash).toBe(hashPromptText("TAMPERED BODY"));
    expect(result.text).toBe("TAMPERED BODY");
  });

  test("a settlement failure surfaces as UnlockFailedError with the server's code and message", async () => {
    const { signer } = recordingSigner();
    const { fetchMock } = fakeUnlockServer(
      [requirement()],
      () =>
        new Response(
          JSON.stringify({ error: "settlement_failed", message: "The facilitator refused to settle." }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    );

    const attempt = unlockPrompt(baseRequest(signer, fetchMock));
    await expect(attempt).rejects.toThrow(UnlockFailedError);
    await expect(attempt).rejects.toMatchObject({
      code: "settlement_failed",
      message: "The facilitator refused to settle.",
    });
  });

  test("an OK answer without text or tx hash is a failure, not a silent unlock", async () => {
    const { signer } = recordingSigner();
    const { fetchMock } = fakeUnlockServer(
      [requirement()],
      () => new Response(JSON.stringify({ id: PROMPT_ID }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(unlockPrompt(baseRequest(signer, fetchMock))).rejects.toThrow(UnlockFailedError);
  });

  test("declining in the wallet throws SignatureRejectedError, refunds the charge, and never fires onSigned", async () => {
    const { signer } = recordingSigner(() => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    const { fetchMock, paid } = fakeUnlockServer([requirement()]);
    const events: string[] = [];

    const request = baseRequest(signer, fetchMock);
    await expect(
      unlockPrompt({ ...request, onSigned: () => events.push("signed") }),
    ).rejects.toThrow(SignatureRejectedError);

    expect(events).toEqual([]);
    expect(paid).toHaveLength(0);
    expect(request.ledger.spent()).toBe(0n);
  });

  test("a server demanding more than the advertised price is refused before any signature", async () => {
    const { signer, payloads } = recordingSigner();
    const { fetchMock, paid } = fakeUnlockServer([requirement({ amount: "600000" })]);

    await expect(unlockPrompt(baseRequest(signer, fetchMock))).rejects.toThrow(
      PerPromptCapExceededError,
    );
    expect(payloads).toHaveLength(0);
    expect(paid).toHaveLength(0);
  });
});

describe("createBrowserSpendLedger", () => {
  test("charges accumulate across ledger instances sharing the same storage", () => {
    const storage = new FakeStorage();
    createBrowserSpendLedger(storage).charge(300_000n, 1_000_000n);
    const second = createBrowserSpendLedger(storage);
    expect(second.spent()).toBe(300_000n);
    second.charge(200_000n, 1_000_000n);
    expect(second.spent()).toBe(500_000n);
  });

  test("a charge over the session cap throws the shared typed error and records nothing", () => {
    const ledger = createBrowserSpendLedger(new FakeStorage());
    ledger.charge(900_000n, 1_000_000n);
    expect(() => ledger.charge(200_000n, 1_000_000n)).toThrow(SessionCapExceededError);
    expect(ledger.spent()).toBe(900_000n);
  });

  test("a refund never drops below zero", () => {
    const ledger = createBrowserSpendLedger(new FakeStorage());
    ledger.charge(100_000n, 1_000_000n);
    expect(ledger.refund(300_000n)).toBe(0n);
  });

  test("a scribbled-on ledger fails CLOSED instead of resetting the budget", () => {
    const storage = new FakeStorage();
    storage.setItem("promit.session.spentAtomic", "not-a-number");
    const ledger = createBrowserSpendLedger(storage);
    expect(() => ledger.spent()).toThrow(SpendLedgerCorruptError);
  });
});
