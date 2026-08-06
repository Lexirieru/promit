import { describe, expect, it } from "vitest";
import { formatUsdc } from "@/lib/api";

describe("formatUsdc", () => {
  it("renders whole cents with two digits", () => {
    expect(formatUsdc("500000")).toBe("$0.50");
    expect(formatUsdc("1000000")).toBe("$1.00");
    expect(formatUsdc("0")).toBe("$0.00");
  });

  it("keeps sub-cent precision only when non-zero", () => {
    expect(formatUsdc("50000")).toBe("$0.05");
    expect(formatUsdc("1234567")).toBe("$1.234567");
    expect(formatUsdc("10500")).toBe("$0.0105");
  });
});
