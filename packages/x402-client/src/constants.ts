/**
 * The only payment denomination Promit ever signs for (KTD14).
 *
 * The policy filter pins all three of these before any amount is compared:
 * an atomic amount is meaningless until the asset it denominates is fixed.
 * An 18-decimal token with a small `amount` signs away orders of magnitude
 * more value than a 6-decimal USDC threshold implies.
 */
export const EXACT_SCHEME = "exact";
export const BASE_SEPOLIA_NETWORK = "eip155:84532";
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export const USDC_DECIMALS = 6;

/** $0.10 in atomic USDC. Applied when a surface configures no per-prompt cap. */
export const DEFAULT_PER_PROMPT_CAP_ATOMIC = 100_000n;
/** $1.00 in atomic USDC. Applied when a surface configures no session cap. */
export const DEFAULT_SESSION_CAP_ATOMIC = 1_000_000n;

const ATOMIC_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/**
 * Parses a human USDC amount ("0.10", 0.1, "$0.10") into atomic units.
 * Rejects negative values and more than 6 decimal places rather than rounding,
 * so a cap read from configuration is never silently widened.
 */
export function usdcToAtomic(value: string | number): bigint {
  const text = String(value).trim().replace(/^\$/, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new RangeError(`not a valid non-negative USDC amount: ${JSON.stringify(value)}`);
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > USDC_DECIMALS) {
    throw new RangeError(
      `USDC has ${USDC_DECIMALS} decimals; ${JSON.stringify(value)} has ${fraction.length} decimal places`,
    );
  }
  return BigInt(whole) * ATOMIC_PER_USDC + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

/** Formats atomic USDC for refusal messages: 5_000_000n -> "$5.00", 99_000n -> "$0.099". */
export function formatUsdc(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const whole = abs / ATOMIC_PER_USDC;
  const fraction = (abs % ATOMIC_PER_USDC).toString().padStart(USDC_DECIMALS, "0");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${sign}$${whole}.${trimmed}`;
}
