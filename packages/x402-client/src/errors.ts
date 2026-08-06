import { formatUsdc } from "./constants";

/** Base class for every refusal this client produces before signing. */
export class PaymentRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export type PolicyViolationField = "scheme" | "network" | "asset" | "amount";

export interface PolicyViolation {
  /** Index of the offending entry in the 402 response's `accepts` array. */
  index: number;
  field: PolicyViolationField;
  actual: string;
  expected: string;
}

/**
 * A payment requirement failed the denomination pin (scheme, network, asset).
 * Thrown before any amount comparison: an under-cap amount in the wrong
 * denomination is still a refusal (KTD14, AE11).
 */
export class PolicyRefusalError extends PaymentRefusedError {
  readonly violations: readonly PolicyViolation[];

  constructor(message: string, violations: readonly PolicyViolation[]) {
    super("POLICY_VIOLATION", message);
    this.violations = violations;
  }
}

/** The demanded amount exceeds the per-prompt cap (AE4). Names both amounts. */
export class PerPromptCapExceededError extends PaymentRefusedError {
  constructor(
    readonly amountAtomic: bigint,
    readonly capAtomic: bigint,
  ) {
    super(
      "PER_PROMPT_CAP_EXCEEDED",
      `refusing payment: demanded ${formatUsdc(amountAtomic)} (${amountAtomic} atomic USDC) ` +
        `exceeds the per-prompt cap of ${formatUsdc(capAtomic)} (${capAtomic} atomic USDC)`,
    );
  }
}

/**
 * The demanded amount would push cumulative session spend over the session cap
 * (AE8). Names the running total, the demand, and the cap.
 */
export class SessionCapExceededError extends PaymentRefusedError {
  constructor(
    readonly amountAtomic: bigint,
    readonly spentAtomic: bigint,
    readonly capAtomic: bigint,
  ) {
    super(
      "SESSION_CAP_EXCEEDED",
      `refusing payment: ${formatUsdc(spentAtomic)} already spent this session ` +
        `(${spentAtomic} atomic USDC) plus the demanded ${formatUsdc(amountAtomic)} ` +
        `(${amountAtomic} atomic USDC) would exceed the cumulative session cap of ` +
        `${formatUsdc(capAtomic)} (${capAtomic} atomic USDC)`,
    );
  }
}

/**
 * The persisted spend ledger exists but cannot be trusted. Failing closed here
 * is deliberate: treating a corrupt ledger as zero would let anything able to
 * scribble on the file reset the budget.
 */
export class SpendLedgerCorruptError extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(
      `spend ledger at ${file} is unreadable (${reason}); refusing to spend against an ` +
        `unknown running total. Inspect the file and repair or remove it deliberately.`,
    );
    this.name = new.target.name;
  }
}

/** Delivered prompt text does not hash to the value the registry recorded. */
export class ContentHashMismatchError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(
      `content hash mismatch: delivered text hashes to ${actualHash}, ` +
        `but the registry records ${expectedHash}. Do not trust this content.`,
    );
    this.name = new.target.name;
  }
}
