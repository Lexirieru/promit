import { describe, expect, test } from "bun:test";
import type { PaymentRequirements } from "@x402/core/types";

import {
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  PerPromptCapExceededError,
  PolicyRefusalError,
  SessionCapExceededError,
  selectPaymentRequirement,
  type SpendPolicy,
} from "../src";

const PAY_TO = "0x2222222222222222222222222222222222222222";

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    asset: BASE_SEPOLIA_USDC,
    amount: "50000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

// $0.10 per prompt, $0.50 per session.
const policy: SpendPolicy = { perPromptCapAtomic: 100_000n, sessionCapAtomic: 500_000n };

describe("denomination pin before amount comparison (KTD14)", () => {
  test("AE11: a different asset is refused even when its amount is below the cap", () => {
    const accepts = [requirement({ asset: "0xdEAD00000000000000000000000000000000dEaD", amount: "50000" })];
    const error = (() => {
      try {
        selectPaymentRequirement(accepts, policy, 0n);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(PolicyRefusalError);
    expect(error).not.toBeInstanceOf(PerPromptCapExceededError);
    expect(error).not.toBeInstanceOf(SessionCapExceededError);
    const refusal = error as PolicyRefusalError;
    expect(refusal.violations).toEqual([
      {
        index: 0,
        field: "asset",
        actual: "0xdEAD00000000000000000000000000000000dEaD",
        expected: BASE_SEPOLIA_USDC,
      },
    ]);
    expect(refusal.message).toContain("before any amount comparison");
    expect(refusal.message).toContain(BASE_SEPOLIA_USDC);
  });

  test("AE11: a different network is refused even when its amount is below the cap", () => {
    const accepts = [requirement({ network: "eip155:8453", amount: "1" })];
    expect(() => selectPaymentRequirement(accepts, policy, 0n)).toThrow(PolicyRefusalError);
    try {
      selectPaymentRequirement(accepts, policy, 0n);
    } catch (error) {
      expect((error as PolicyRefusalError).violations[0]?.field).toBe("network");
      expect((error as PolicyRefusalError).message).toContain("eip155:8453");
      expect((error as PolicyRefusalError).message).toContain(BASE_SEPOLIA_NETWORK);
    }
  });

  test("a scheme that is not exact is refused", () => {
    const accepts = [requirement({ scheme: "upto" })];
    try {
      selectPaymentRequirement(accepts, policy, 0n);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyRefusalError);
      expect((error as PolicyRefusalError).violations[0]?.field).toBe("scheme");
    }
  });

  test("denomination violations win over amount violations: wrong asset above cap is a policy refusal, not a cap refusal", () => {
    // A tiny-looking amount in an 18-decimal token would sign away far more
    // value than the USDC cap implies; the asset pin must fire first.
    const accepts = [requirement({ asset: "0xdEAD00000000000000000000000000000000dEaD", amount: "999000000000000000000" })];
    expect(() => selectPaymentRequirement(accepts, policy, 0n)).toThrow(PolicyRefusalError);
  });

  test("the asset comparison is case-insensitive", () => {
    const accepts = [requirement({ asset: BASE_SEPOLIA_USDC.toLowerCase() })];
    expect(selectPaymentRequirement(accepts, policy, 0n)).toBe(accepts[0]!);
  });

  test("an empty accepts array is refused", () => {
    expect(() => selectPaymentRequirement([], policy, 0n)).toThrow(PolicyRefusalError);
  });

  test("a malformed atomic amount is refused", () => {
    for (const amount of ["1e6", "-5", "0.10", "", "0x10"]) {
      expect(() => selectPaymentRequirement([requirement({ amount })], policy, 0n)).toThrow(
        PolicyRefusalError,
      );
    }
  });
});

describe("per-prompt cap (AE4)", () => {
  test("a $5.00 demand against a $0.10 cap is refused and the refusal names both amounts", () => {
    const accepts = [requirement({ amount: "5000000" })];
    try {
      selectPaymentRequirement(accepts, policy, 0n);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PerPromptCapExceededError);
      const refusal = error as PerPromptCapExceededError;
      expect(refusal.amountAtomic).toBe(5_000_000n);
      expect(refusal.capAtomic).toBe(100_000n);
      expect(refusal.message).toContain("$5.00");
      expect(refusal.message).toContain("$0.10");
      expect(refusal.message).toContain("5000000");
      expect(refusal.message).toContain("100000");
    }
  });

  test("an amount exactly at the cap is accepted", () => {
    const accepts = [requirement({ amount: "100000" })];
    expect(selectPaymentRequirement(accepts, policy, 0n)).toBe(accepts[0]!);
  });
});

describe("cumulative session cap (AE8)", () => {
  test("an individually-under-cap purchase is refused once the session total would exceed the cap, naming the running total", () => {
    // Five completed $0.10 purchases against a $0.50 session cap.
    try {
      selectPaymentRequirement([requirement({ amount: "100000" })], policy, 500_000n);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCapExceededError);
      const refusal = error as SessionCapExceededError;
      expect(refusal.spentAtomic).toBe(500_000n);
      expect(refusal.capAtomic).toBe(500_000n);
      expect(refusal.message).toContain("$0.50");
      expect(refusal.message).toContain("500000");
      expect(refusal.message).toContain("$0.10");
    }
  });

  test("spending exactly up to the session cap is accepted", () => {
    const accepts = [requirement({ amount: "100000" })];
    expect(selectPaymentRequirement(accepts, policy, 400_000n)).toBe(accepts[0]!);
  });
});

describe("selection among multiple candidates", () => {
  test("a conforming candidate is selected even when a non-conforming one is listed first", () => {
    const bad = requirement({ asset: "0xdEAD00000000000000000000000000000000dEaD", amount: "1" });
    const good = requirement({ amount: "40000" });
    expect(selectPaymentRequirement([bad, good], policy, 0n)).toBe(good);
  });

  test("the cheapest conforming candidate is selected", () => {
    const dear = requirement({ amount: "90000" });
    const cheap = requirement({ amount: "30000" });
    expect(selectPaymentRequirement([dear, cheap], policy, 0n)).toBe(cheap);
  });
});
