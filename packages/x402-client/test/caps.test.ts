import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionCapExceededError, SpendLedger, SpendLedgerCorruptError, defaultConfigDir } from "../src";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "promit-ledger-"));
}

describe("SpendLedger", () => {
  test("starts at zero and accumulates charges", () => {
    const ledger = new SpendLedger({ dir: freshDir() });
    expect(ledger.spent()).toBe(0n);
    ledger.charge(100_000n, 500_000n);
    ledger.charge(50_000n, 500_000n);
    expect(ledger.spent()).toBe(150_000n);
  });

  test("cumulative spend survives a process restart", () => {
    const dir = freshDir();
    const before = new SpendLedger({ dir });
    before.charge(400_000n, 500_000n);

    // A restarted process constructs a fresh ledger over the same directory.
    const after = new SpendLedger({ dir });
    expect(after.spent()).toBe(400_000n);
    expect(() => after.charge(200_000n, 500_000n)).toThrow(SessionCapExceededError);
  });

  test("AE8: five $0.10 charges against a $0.50 cap, then the sixth is refused naming the running total", () => {
    const ledger = new SpendLedger({ dir: freshDir() });
    for (let i = 0; i < 5; i++) {
      ledger.charge(100_000n, 500_000n);
    }
    try {
      ledger.charge(100_000n, 500_000n);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCapExceededError);
      expect((error as SessionCapExceededError).spentAtomic).toBe(500_000n);
      expect((error as SessionCapExceededError).message).toContain("$0.50");
    }
    // The refused charge must not have been recorded.
    expect(ledger.spent()).toBe(500_000n);
  });

  test("a refused charge leaves the persisted file untouched", () => {
    const dir = freshDir();
    const ledger = new SpendLedger({ dir });
    ledger.charge(100_000n, 500_000n);
    const persisted = readFileSync(ledger.file, "utf8");
    expect(() => ledger.charge(1_000_000n, 500_000n)).toThrow(SessionCapExceededError);
    expect(readFileSync(ledger.file, "utf8")).toBe(persisted);
  });

  test("refund reverses a charge and floors at zero", () => {
    const ledger = new SpendLedger({ dir: freshDir() });
    ledger.charge(100_000n, 500_000n);
    expect(ledger.refund(60_000n)).toBe(40_000n);
    expect(ledger.refund(999_999n)).toBe(0n);
  });

  test("a corrupt ledger fails closed instead of resetting the budget", () => {
    const dir = freshDir();
    const ledger = new SpendLedger({ dir });
    ledger.charge(100_000n, 500_000n);

    writeFileSync(ledger.file, "not json at all", "utf8");
    expect(() => ledger.spent()).toThrow(SpendLedgerCorruptError);
    expect(() => ledger.charge(1n, 500_000n)).toThrow(SpendLedgerCorruptError);

    writeFileSync(ledger.file, JSON.stringify({ version: 1, spentAtomic: -5 }), "utf8");
    expect(() => ledger.spent()).toThrow(SpendLedgerCorruptError);
  });

  test("reset zeroes the ledger", () => {
    const ledger = new SpendLedger({ dir: freshDir() });
    ledger.charge(100_000n, 500_000n);
    ledger.reset();
    expect(ledger.spent()).toBe(0n);
  });

  test("negative charges and refunds are rejected", () => {
    const ledger = new SpendLedger({ dir: freshDir() });
    expect(() => ledger.charge(-1n, 500_000n)).toThrow(RangeError);
    expect(() => ledger.refund(-1n)).toThrow(RangeError);
  });

  test("defaultConfigDir honours PROMIT_CONFIG_DIR", () => {
    const previous = process.env.PROMIT_CONFIG_DIR;
    try {
      process.env.PROMIT_CONFIG_DIR = "/somewhere/else";
      expect(defaultConfigDir()).toBe("/somewhere/else");
      delete process.env.PROMIT_CONFIG_DIR;
      expect(defaultConfigDir()).toContain(join(".config", "promit"));
    } finally {
      if (previous === undefined) {
        delete process.env.PROMIT_CONFIG_DIR;
      } else {
        process.env.PROMIT_CONFIG_DIR = previous;
      }
    }
  });
});
