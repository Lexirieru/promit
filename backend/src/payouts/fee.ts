/**
 * The protocol fee split (2026-08-08).
 *
 * x402's `exact` scheme settles one EIP-3009 `transferWithAuthorization`: one
 * signature, one amount, one recipient. A payment cannot be split between the
 * creator and the protocol at settlement time. So the treasury receives the
 * gross, and the creator's share is forwarded afterwards — this module owns
 * the arithmetic of that split and nothing else, so it can be reasoned about
 * without a chain, a database, or a key.
 *
 * Everything is atomic USDC (6 decimals) as `bigint`. No floating point ever
 * touches a balance: `0.1 * 0.025` is not 0.0025 in binary floating point, and
 * a cent that rounds the wrong way is a cent someone is owed.
 */

/** Basis points: 10000 bps = 100%. */
export const BPS_DENOMINATOR = 10_000n;

/** 2.5%. Chosen by the operator; override with `PROMIT_FEE_BPS`. */
export const DEFAULT_FEE_BPS = 250n;

export class InvalidFeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFeeError";
  }
}

/**
 * Reads the configured fee, failing loudly rather than falling back.
 *
 * A malformed `PROMIT_FEE_BPS` silently defaulting to 250 would pay creators a
 * rate nobody chose, and the mistake would only surface in a balance. A typo
 * should stop the worker at preflight instead.
 */
export function feeBpsFromEnv(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.PROMIT_FEE_BPS;
  if (raw === undefined || raw === "") return DEFAULT_FEE_BPS;
  if (!/^\d+$/.test(raw)) {
    throw new InvalidFeeError(
      `PROMIT_FEE_BPS must be a non-negative integer number of basis points, got ${JSON.stringify(raw)}`,
    );
  }
  const bps = BigInt(raw);
  if (bps > BPS_DENOMINATOR) {
    throw new InvalidFeeError(
      `PROMIT_FEE_BPS ${bps} exceeds 10000 bps (100%) — the creator would receive a negative amount`,
    );
  }
  return bps;
}

export interface PayoutSplit {
  /** What the buyer paid, and what the treasury received. */
  grossAtomic: bigint;
  /** The protocol's cut, kept in the treasury. */
  feeAtomic: bigint;
  /** What the creator is owed. */
  netAtomic: bigint;
}

/**
 * Splits a gross payment into the protocol fee and the creator's share.
 *
 * The fee is floored, so the rounding remainder always goes to the CREATOR,
 * never to the protocol. That direction is deliberate: a house that rounds in
 * its own favour on every sale is a house nobody audits twice. At 2.5% the
 * remainder is at most one atomic unit — a millionth of a dollar — but the
 * rule is what matters, not the size.
 *
 * `fee + net === gross` holds exactly for every input, which is the invariant
 * that makes a treasury balance reconcilable against the payout table.
 */
export function splitPayout(grossAtomic: bigint, feeBps: bigint): PayoutSplit {
  if (grossAtomic < 0n) {
    throw new InvalidFeeError(`gross amount cannot be negative: ${grossAtomic}`);
  }
  if (feeBps < 0n || feeBps > BPS_DENOMINATOR) {
    throw new InvalidFeeError(`fee must be between 0 and ${BPS_DENOMINATOR} bps, got ${feeBps}`);
  }
  const feeAtomic = (grossAtomic * feeBps) / BPS_DENOMINATOR;
  return { grossAtomic, feeAtomic, netAtomic: grossAtomic - feeAtomic };
}

/** "250" → "2.5%", for logs and the published fee endpoint. */
export function formatFeeBps(feeBps: bigint): string {
  const whole = feeBps / 100n;
  const frac = (feeBps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}%` : `${whole}%`;
}
