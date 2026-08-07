import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

import {
  FREE_TEXT,
  PAID_TEXT,
  PAID_TX_HASH,
  TEST_PRIVATE_KEY,
  freshConfigDir,
  runCli,
  startMockApi,
  type MockApi,
} from "./helpers";
import { saveKeystore } from "../src/wallet/keystore";

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});
afterAll(() => {
  api.stop();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { PROMIT_API_URL: api.url, PROMIT_CONFIG_DIR: freshConfigDir(), ...extra };
}

describe("promit (bare invocation and banner)", () => {
  test("--help lists all five subcommands", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    for (const name of ["search", "preview", "buy", "verify", "wallet"]) {
      expect(result.stdout + result.stderr).toContain(name);
    }
  });

  test("the banner is suppressed when stdout is not a TTY", async () => {
    const result = await runCli([], { env: env() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("█");
    // Usage still prints so a piped bare invocation is not silent.
    expect(result.stdout + result.stderr).toContain("USAGE");
  });

  test("the banner is suppressed when NO_COLOR is set", async () => {
    const result = await runCli([], { env: env({ NO_COLOR: "1" }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("█");
  });
});

describe("promit search", () => {
  test("finds prompts by substring and renders a table row per hit", async () => {
    const result = await runCli(["search", "landing"], { env: env() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("paid-landing");
    expect(result.stdout).toContain("$0.05");
  });

  test("reports an empty result in words, never an empty table frame", async () => {
    const result = await runCli(["search", "zzz-no-such-prompt"], { env: env() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No prompts match");
    // No table borders of any kind.
    expect(result.stdout).not.toMatch(/[┌┐└┘│─]/);
  });

  test("an unknown tier is refused with a named error", async () => {
    const result = await runCli(["search", "--tier", "premium"], { env: env() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown tier");
  });

  test("an unreachable API is a named error, not a stack trace", async () => {
    const result = await runCli(["search"], {
      env: { PROMIT_API_URL: "http://127.0.0.1:9", PROMIT_CONFIG_DIR: freshConfigDir() },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("could not reach the Promit API");
  });
});

describe("promit preview", () => {
  test("shows title, price, and content hash for a known id", async () => {
    const result = await runCli(["preview", "paid-landing"], { env: env() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Paid landing page");
    expect(result.stdout).toContain("$0.05");
    expect(result.stdout).toContain("keccak256:");
  });

  test("an unknown id exits non-zero with the API's message", async () => {
    const result = await runCli(["preview", "nope"], { env: env() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No prompt with id "nope"');
  });
});

describe("promit buy — free tier", () => {
  test("a free prompt needs no wallet, no payment, and no --yes even non-interactively", async () => {
    const result = await runCli(["buy", "free-hero"], { env: env() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(FREE_TEXT);
    expect(result.stderr).toContain("content hash verified");
    // No payment was demanded or attempted.
    expect(result.stderr).not.toContain("tx ");
  });
});

describe("promit buy — paid tier", () => {
  test("AE2: buy --yes completes the x402 exchange, prints the text on stdout and the tx hash on stderr", async () => {
    const result = await runCli(["buy", "paid-landing", "--yes"], {
      env: env({ PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY }),
    });
    expect(result.exitCode).toBe(0);
    // stdout carries exactly the prompt text (plus trailing newline), so
    // `> prompt.txt` captures the purchase.
    expect(result.stdout).toBe(`${PAID_TEXT}\n`);
    expect(result.stderr).toContain(PAID_TX_HASH);
    expect(result.stderr).toContain("content hash verified");
  });

  test("without --yes on a non-interactive stdin it fails immediately with an explicit error", async () => {
    const before = api.requests.length;
    const result = await runCli(["buy", "paid-landing"], {
      env: env({ PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(result.stderr).toContain("not interactive");
    // It failed before the unlock route was ever touched: only the catalog
    // lookup happened, so no payment challenge was even requested.
    const touched = api.requests.slice(before).map((r) => r.path);
    expect(touched).not.toContain("/v1/prompts/paid-landing");
  });

  test("AE4: a price above the per-prompt cap is refused naming both amounts, with no signature sent", async () => {
    const before = api.requests.length;
    const result = await runCli(["buy", "paid-expensive", "--yes"], {
      env: env({ PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("$5.00");
    expect(result.stderr).toContain("$0.10");
    // The 402 challenge was read, but no paid retry ever carried a signature.
    const paid = api.requests.slice(before).filter((r) => r.hasPaymentSignature);
    expect(paid).toHaveLength(0);
  });

  test("AE8: a purchase that would exceed the session cap is refused naming the running total", async () => {
    const configDir = freshConfigDir();
    const shared = {
      PROMIT_API_URL: api.url,
      PROMIT_CONFIG_DIR: configDir,
      PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
    };
    // First $0.05 purchase fits under the $0.08 session cap.
    const first = await runCli(["buy", "paid-landing", "--yes", "--session-cap", "0.08"], {
      env: shared,
    });
    expect(first.exitCode).toBe(0);
    // The second would take the session to $0.10 > $0.08: refused before any
    // signature, naming the running total and the cap.
    const before = api.requests.length;
    const second = await runCli(["buy", "paid-landing", "--yes", "--session-cap", "0.08"], {
      env: shared,
    });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("$0.05");
    expect(second.stderr).toContain("$0.08");
    const paid = api.requests.slice(before).filter((r) => r.hasPaymentSignature);
    expect(paid).toHaveLength(0);
  });

  test("an unknown id fails before any wallet or payment machinery", async () => {
    const result = await runCli(["buy", "nope", "--yes"], { env: env() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No prompt with id "nope"');
  });

  test("a keystore cannot be decrypted non-interactively: named error, no hang", async () => {
    const configDir = freshConfigDir();
    await saveKeystore("default", TEST_PRIVATE_KEY as `0x${string}`, "pw", {
      configDir,
      scrypt: { N: 1 << 10, r: 8, p: 1 },
    });
    const result = await runCli(["buy", "paid-landing", "--yes"], {
      env: { PROMIT_API_URL: api.url, PROMIT_CONFIG_DIR: configDir },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PROMIT_PRIVATE_KEY");
  });
});

describe("promit wallet", () => {
  test("show prefers PROMIT_PRIVATE_KEY over an existing keystore and says so", async () => {
    const configDir = freshConfigDir();
    const otherKey = `0x${"22".repeat(32)}` as `0x${string}`;
    await saveKeystore("default", otherKey, "pw", {
      configDir,
      scrypt: { N: 1 << 10, r: 8, p: 1 },
    });
    const result = await runCli(["wallet", "show"], {
      env: { PROMIT_CONFIG_DIR: configDir, PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      privateKeyToAccount(TEST_PRIVATE_KEY as `0x${string}`).address,
    );
    expect(result.stderr).toContain("PROMIT_PRIVATE_KEY");
  });

  test("show refuses a group- or world-readable keystore", async () => {
    const configDir = freshConfigDir();
    const saved = await saveKeystore("default", TEST_PRIVATE_KEY as `0x${string}`, "pw", {
      configDir,
      scrypt: { N: 1 << 10, r: 8, p: 1 },
    });
    chmodSync(saved.file, 0o644);
    const result = await runCli(["wallet", "show"], {
      env: { PROMIT_CONFIG_DIR: configDir },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("chmod 600");
  });

  test("create refuses to run without an interactive terminal", async () => {
    const result = await runCli(["wallet", "create"], {
      env: { PROMIT_CONFIG_DIR: freshConfigDir() },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("interactive");
    expect(result.stderr).toContain("PROMIT_PRIVATE_KEY");
  });
});
