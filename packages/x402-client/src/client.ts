import { x402Client, x402HTTPClient, type BeforePaymentCreationHook } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

import { SpendLedger } from "./caps";
import {
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  DEFAULT_PER_PROMPT_CAP_ATOMIC,
  DEFAULT_SESSION_CAP_ATOMIC,
  EXACT_SCHEME,
} from "./constants";
import {
  PerPromptCapExceededError,
  PolicyRefusalError,
  SessionCapExceededError,
  type PolicyViolation,
} from "./errors";

export interface SpendPolicy {
  perPromptCapAtomic: bigint;
  sessionCapAtomic: bigint;
}

/** Plain call signature so mocks and wrapped fetches interchange freely. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function denominationViolations(requirement: PaymentRequirements, index: number): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  if (requirement.scheme !== EXACT_SCHEME) {
    violations.push({ index, field: "scheme", actual: requirement.scheme, expected: EXACT_SCHEME });
  }
  if (requirement.network !== BASE_SEPOLIA_NETWORK) {
    violations.push({ index, field: "network", actual: requirement.network, expected: BASE_SEPOLIA_NETWORK });
  }
  if (requirement.asset.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
    violations.push({ index, field: "asset", actual: requirement.asset, expected: BASE_SEPOLIA_USDC });
  }
  return violations;
}

function atomicAmount(requirement: PaymentRequirements, index: number): bigint {
  if (!/^\d+$/.test(requirement.amount)) {
    throw new PolicyRefusalError(
      `refusing payment: accepts[${index}].amount ${JSON.stringify(requirement.amount)} is not a ` +
        `non-negative integer atomic amount`,
      [{ index, field: "amount", actual: requirement.amount, expected: "a base-10 atomic integer" }],
    );
  }
  return BigInt(requirement.amount);
}

/**
 * The policy filter (KTD14). Pins the denomination - scheme `exact`, network
 * `eip155:84532`, asset Base Sepolia USDC - and only then compares atomic
 * amounts against the per-prompt cap and the cumulative session cap.
 *
 * The order is the point: an atomic amount is only comparable against a USDC
 * cap once the asset is known to be USDC. A below-cap `amount` denominated in
 * an 18-decimal token is refused here on the asset pin (AE11), never accepted
 * on the amount.
 *
 * Throws a {@link PolicyRefusalError}, {@link PerPromptCapExceededError}, or
 * {@link SessionCapExceededError}; returns the cheapest conforming
 * requirement otherwise.
 */
export function selectPaymentRequirement(
  accepts: readonly PaymentRequirements[],
  policy: SpendPolicy,
  sessionSpentAtomic: bigint,
): PaymentRequirements {
  if (accepts.length === 0) {
    throw new PolicyRefusalError("refusing payment: the server offered no payment requirements", []);
  }

  const violations: PolicyViolation[] = [];
  const conforming: PaymentRequirements[] = [];
  accepts.forEach((requirement, index) => {
    const found = denominationViolations(requirement, index);
    if (found.length === 0) {
      conforming.push(requirement);
    } else {
      violations.push(...found);
    }
  });

  if (conforming.length === 0) {
    const detail = violations
      .map(
        (violation) =>
          `accepts[${violation.index}].${violation.field} is ${JSON.stringify(violation.actual)} ` +
          `but Promit only pays ${violation.field} ${JSON.stringify(violation.expected)}`,
      )
      .join("; ");
    throw new PolicyRefusalError(
      `refusing payment before any amount comparison: ${detail}`,
      violations,
    );
  }

  const candidate = conforming.reduce((cheapest, requirement) =>
    atomicAmount(requirement, accepts.indexOf(requirement)) <
    atomicAmount(cheapest, accepts.indexOf(cheapest))
      ? requirement
      : cheapest,
  );
  const amount = atomicAmount(candidate, accepts.indexOf(candidate));

  if (amount > policy.perPromptCapAtomic) {
    throw new PerPromptCapExceededError(amount, policy.perPromptCapAtomic);
  }
  if (sessionSpentAtomic + amount > policy.sessionCapAtomic) {
    throw new SessionCapExceededError(amount, sessionSpentAtomic, policy.sessionCapAtomic);
  }
  return candidate;
}

export interface PromitFetchOptions {
  /** Typically a viem `LocalAccount` (`privateKeyToAccount(...)`). */
  signer: ClientEvmSigner;
  /** Atomic USDC. Defaults to {@link DEFAULT_PER_PROMPT_CAP_ATOMIC} ($0.10). */
  perPromptCapAtomic?: bigint;
  /** Atomic USDC. Defaults to {@link DEFAULT_SESSION_CAP_ATOMIC} ($1.00). */
  sessionCapAtomic?: bigint;
  /** Overrides the ledger location; defaults to `~/.config/promit/`. */
  configDir?: string;
  /** Full control over ledger construction; wins over `configDir`. */
  ledger?: SpendLedger;
  /**
   * Runs after the policy filter accepts a requirement and before any
   * signature is produced. Return `{ abort: true, reason }` (or throw) to veto
   * the payment - the CLI uses this for its interactive confirmation.
   */
  onBeforePaymentCreation?: BeforePaymentCreationHook;
  /** Base fetch to wrap; defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

export interface PromitFetchHandle {
  /** Drop-in fetch that answers 402 challenges within the spend policy. */
  fetchWithPayment: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  client: x402Client;
  ledger: SpendLedger;
  policy: SpendPolicy;
}

/**
 * The one payment client every Promit surface uses (KTD19). Wraps fetch with
 * x402 v2 payment handling and enforces the spend policy in two places:
 *
 * - on the raw 402 response, against the server's original `accepts` array,
 *   so a refusal surfaces as a typed error naming exactly what was wrong
 *   before the x402 machinery sees the challenge;
 * - again in the client's requirement selector and `onBeforePaymentCreation`
 *   hook, where the ledger charge is atomically re-checked, so no code path -
 *   including a future one that bypasses our fetch wrapper - reaches the
 *   signer without passing the same policy.
 *
 * The ledger is charged before the signature is produced and refunded only if
 * payload creation fails, because a produced signature can be settled inside
 * its validity window even when no response comes back.
 */
export function createPromitFetch(options: PromitFetchOptions): PromitFetchHandle {
  const policy: SpendPolicy = {
    perPromptCapAtomic: options.perPromptCapAtomic ?? DEFAULT_PER_PROMPT_CAP_ATOMIC,
    sessionCapAtomic: options.sessionCapAtomic ?? DEFAULT_SESSION_CAP_ATOMIC,
  };
  const ledger = options.ledger ?? new SpendLedger({ dir: options.configDir });

  const client = new x402Client((_version, requirements) =>
    selectPaymentRequirement(requirements, policy, ledger.spent()),
  );
  registerExactEvmScheme(client, {
    signer: options.signer,
    networks: [BASE_SEPOLIA_NETWORK],
  });

  if (options.onBeforePaymentCreation) {
    client.onBeforePaymentCreation(options.onBeforePaymentCreation);
  }
  client.onBeforePaymentCreation(async (context) => {
    const requirement = context.selectedRequirements;
    selectPaymentRequirement([requirement], policy, ledger.spent());
    ledger.charge(BigInt(requirement.amount), policy.sessionCapAtomic);
  });
  client.onPaymentCreationFailure(async (context) => {
    ledger.refund(BigInt(context.selectedRequirements.amount));
  });

  const httpClient = new x402HTTPClient(client);
  const baseFetch = options.fetch ?? globalThis.fetch;

  const guardedFetch: FetchLike = async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status !== 402 || hasPaymentSignature(input, init)) {
      return response;
    }
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = await parse402(httpClient, response);
    } catch {
      // Not an x402 challenge we can read; hand it back unchanged and let the
      // wrapper produce its own parse failure.
      return response;
    }
    selectPaymentRequirement(paymentRequired.accepts, policy, ledger.spent());
    return response;
  };

  return {
    fetchWithPayment: wrapFetchWithPayment(guardedFetch as typeof globalThis.fetch, client),
    client,
    ledger,
    policy,
  };
}

function hasPaymentSignature(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers && new Headers(init.headers).has("PAYMENT-SIGNATURE")) {
    return true;
  }
  return input instanceof Request && input.headers.has("PAYMENT-SIGNATURE");
}

async function parse402(httpClient: x402HTTPClient, response: Response): Promise<PaymentRequired> {
  let body: unknown;
  try {
    const text = await response.clone().text();
    if (text) {
      body = JSON.parse(text);
    }
  } catch {
    // Header-only challenges are valid; the body is optional context.
  }
  return httpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body);
}
