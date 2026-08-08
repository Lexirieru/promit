import { describe, expect, test } from "bun:test";

import {
  BPS_DENOMINATOR,
  DEFAULT_FEE_BPS,
  InvalidFeeError,
  formatFeeBps,
  feeBpsFromEnv,
  splitPayout,
} from "./fee";

/**
 * The split is the only place a creator's earnings are decided, so the
 * properties matter more than any single example.
 */
describe("splitPayout", () => {
  test("fee and net always reconstruct the gross exactly", () => {
    // The invariant that lets a treasury balance be reconciled against the
    // payout table. Checked across awkward amounts, not just round ones.
    for (const gross of [0n, 1n, 7n, 99n, 100_000n, 999_999n, 1_000_000n, 123_456_789n]) {
      for (const bps of [0n, 1n, 250n, 999n, 5_000n, BPS_DENOMINATOR]) {
        const { feeAtomic, netAtomic } = splitPayout(gross, bps);
        expect(feeAtomic + netAtomic).toBe(gross);
        expect(feeAtomic).toBeGreaterThanOrEqual(0n);
        expect(netAtomic).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  test("2.5% of $0.10 leaves the creator $0.0975", () => {
    const { feeAtomic, netAtomic } = splitPayout(100_000n, DEFAULT_FEE_BPS);

    expect(feeAtomic).toBe(2_500n);
    expect(netAtomic).toBe(97_500n);
  });

  test("rounding remainders go to the creator, never the protocol", () => {
    // 1 atomic unit at 2.5% is 0.025 units of fee. Flooring hands the whole
    // unit to the creator. A house that rounded its own way on every sale
    // would quietly accumulate what it never charged.
    const { feeAtomic, netAtomic } = splitPayout(1n, DEFAULT_FEE_BPS);

    expect(feeAtomic).toBe(0n);
    expect(netAtomic).toBe(1n);
  });

  test("a zero fee pays the creator the whole gross", () => {
    expect(splitPayout(100_000n, 0n)).toEqual({
      grossAtomic: 100_000n,
      feeAtomic: 0n,
      netAtomic: 100_000n,
    });
  });

  test("refuses a negative gross and an out-of-range fee", () => {
    expect(() => splitPayout(-1n, DEFAULT_FEE_BPS)).toThrow(InvalidFeeError);
    expect(() => splitPayout(100n, -1n)).toThrow(InvalidFeeError);
    expect(() => splitPayout(100n, BPS_DENOMINATOR + 1n)).toThrow(InvalidFeeError);
  });
});

describe("feeBpsFromEnv", () => {
  test("defaults to 2.5% when unset or empty", () => {
    expect(feeBpsFromEnv({})).toBe(DEFAULT_FEE_BPS);
    expect(feeBpsFromEnv({ PROMIT_FEE_BPS: "" })).toBe(DEFAULT_FEE_BPS);
  });

  test("reads a configured rate", () => {
    expect(feeBpsFromEnv({ PROMIT_FEE_BPS: "1000" })).toBe(1_000n);
    expect(feeBpsFromEnv({ PROMIT_FEE_BPS: "0" })).toBe(0n);
  });

  test("a malformed rate throws instead of silently defaulting", () => {
    // Falling back to 250 on a typo would pay a rate nobody chose, and the
    // mistake would only ever surface as a wrong balance.
    for (const raw of ["2.5", "-100", "2,5", "ten", "250 "]) {
      expect(() => feeBpsFromEnv({ PROMIT_FEE_BPS: raw })).toThrow(InvalidFeeError);
    }
  });

  test("a rate above 100% throws rather than paying a negative amount", () => {
    expect(() => feeBpsFromEnv({ PROMIT_FEE_BPS: "10001" })).toThrow(InvalidFeeError);
    expect(feeBpsFromEnv({ PROMIT_FEE_BPS: "10000" })).toBe(BPS_DENOMINATOR);
  });
});

describe("formatFeeBps", () => {
  test("renders rates the way a human would write them", () => {
    expect(formatFeeBps(250n)).toBe("2.5%");
    expect(formatFeeBps(1_000n)).toBe("10%");
    expect(formatFeeBps(0n)).toBe("0%");
    expect(formatFeeBps(1n)).toBe("0.01%");
  });
});
