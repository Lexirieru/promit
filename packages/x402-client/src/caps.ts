import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SessionCapExceededError, SpendLedgerCorruptError } from "./errors";

const LEDGER_FILE = "spend.json";
const LEDGER_VERSION = 1;

/** Resolution order: explicit dir > PROMIT_CONFIG_DIR > ~/.config/promit. */
export function defaultConfigDir(): string {
  return process.env.PROMIT_CONFIG_DIR ?? join(homedir(), ".config", "promit");
}

/**
 * Cumulative session spend, persisted under `~/.config/promit/spend.json`.
 *
 * The ledger lives on disk, not in memory, so a restarted process resumes the
 * running total instead of resetting its own budget (KTD14): a per-prompt cap
 * alone is defeated by repetition, and repetition across restarts is the
 * cheapest kind. Every read goes back to the file, so concurrent Promit
 * surfaces (CLI and MCP server side by side) observe each other's spending.
 */
export class SpendLedger {
  readonly file: string;

  constructor(options: { dir?: string } = {}) {
    this.file = join(options.dir ?? defaultConfigDir(), LEDGER_FILE);
  }

  /** Current cumulative spend in atomic USDC, read fresh from disk. */
  spent(): bigint {
    return this.read();
  }

  /**
   * Atomically checks `spent + amount <= cap` and records the spend.
   * This is the enforcement point: callers may pre-check for a friendlier
   * early refusal, but only a passed `charge` may be followed by a signature.
   */
  charge(amountAtomic: bigint, sessionCapAtomic: bigint): bigint {
    if (amountAtomic < 0n) {
      throw new RangeError(`cannot charge a negative amount: ${amountAtomic}`);
    }
    const spent = this.read();
    const next = spent + amountAtomic;
    if (next > sessionCapAtomic) {
      throw new SessionCapExceededError(amountAtomic, spent, sessionCapAtomic);
    }
    this.write(next);
    return next;
  }

  /**
   * Reverses a charge whose payment payload creation failed before a signature
   * existed. Never call this after a signature was produced: a signed
   * authorization can still be settled inside its validity window even when
   * the response was lost, so the value must stay counted.
   */
  refund(amountAtomic: bigint): bigint {
    if (amountAtomic < 0n) {
      throw new RangeError(`cannot refund a negative amount: ${amountAtomic}`);
    }
    const spent = this.read();
    const next = spent > amountAtomic ? spent - amountAtomic : 0n;
    this.write(next);
    return next;
  }

  /**
   * Zeroes the ledger. Exists for an explicit human decision (a CLI budget
   * command behind a confirmation), never for agent code: an agent that can
   * reset its own budget has no budget.
   */
  reset(): void {
    this.write(0n);
  }

  private read(): bigint {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0n;
      }
      throw new SpendLedgerCorruptError(this.file, String(error));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SpendLedgerCorruptError(this.file, "not valid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { spentAtomic?: unknown }).spentAtomic !== "string" ||
      !/^\d+$/.test((parsed as { spentAtomic: string }).spentAtomic)
    ) {
      throw new SpendLedgerCorruptError(this.file, "spentAtomic is not a non-negative integer string");
    }
    return BigInt((parsed as { spentAtomic: string }).spentAtomic);
  }

  private write(spentAtomic: bigint): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: LEDGER_VERSION, spentAtomic: spentAtomic.toString(), updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    renameSync(tmp, this.file);
  }
}
