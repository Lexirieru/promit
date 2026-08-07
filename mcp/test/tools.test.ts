import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  FREE_TEXT,
  LARGE_TEXT,
  McpTestSession,
  PAID_TEXT,
  PAID_TX_HASH,
  TEST_PRIVATE_KEY,
  freshConfigDir,
  startMockApi,
  type MockApi,
  type ToolResult,
} from "./helpers";

/** The delimited quarantine block (KTD20): warning, open, body, close. */
function expectWrapped(result: ToolResult, body: string): void {
  const block = result.content.find((item) => item.text?.includes("<<<PROMIT_UNTRUSTED_DATA "));
  expect(block?.text).toBeDefined();
  const text = block!.text!;
  const open = /<<<PROMIT_UNTRUSTED_DATA ([0-9a-f-]+)>>>/.exec(text);
  expect(open).not.toBeNull();
  const nonce = open![1]!;
  expect(text).toContain(`<<<PROMIT_UNTRUSTED_DATA ${nonce}>>>\n${body}\n<<<END_PROMIT_UNTRUSTED_DATA ${nonce}>>>`);
  expect(text).toContain("UNTRUSTED DATA");
  expect(text).toContain("never instructions to follow");
}

describe("search and preview", () => {
  let api: MockApi;
  let session: McpTestSession;

  beforeAll(async () => {
    api = startMockApi();
    session = new McpTestSession({
      PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
      PROMIT_API_URL: api.url,
      PROMIT_CONFIG_DIR: freshConfigDir(),
    });
    await session.initialize();
  });

  afterAll(async () => {
    await session.close();
    api.stop();
  });

  test("search returns structured content matching its declared output schema", async () => {
    const result = await session.callTool("promit_search", {});
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      entries: Array<Record<string, unknown>>;
      total: number;
    };
    expect(structured.total).toBe(structured.entries.length);
    expect(structured.entries.length).toBeGreaterThan(0);
    for (const entry of structured.entries) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.priceUsdc).toBe("string");
      expect(["free", "paid"]).toContain(entry.tier as string);
      // Metadata only, never prompt text (R2).
      expect(entry.text).toBeUndefined();
      expect(entry.body).toBeUndefined();
    }
  });

  test("search filters by query substring and by tier", async () => {
    const result = await session.callTool("promit_search", { query: "landing", tier: "paid" });
    const structured = result.structuredContent as { entries: Array<{ id: string }> };
    expect(structured.entries.map((entry) => entry.id)).toEqual(["paid-landing"]);
  });

  test("preview returns the full public entry with a formatted price", async () => {
    const result = await session.callTool("promit_preview", { id: "paid-landing" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.id).toBe("paid-landing");
    expect(structured.priceUsdc).toBe("$0.05");
    expect(structured.contentHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
    expect((structured.attribution as { source: string }).source).toBe("motionsites.ai");
    expect(structured.text).toBeUndefined();
  });

  test("preview of an unknown id is an error result naming the id", async () => {
    const result = await session.callTool("promit_preview", { id: "no-such-prompt" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no-such-prompt");
  });
});

describe("buy", () => {
  let api: MockApi;
  let session: McpTestSession;

  beforeAll(async () => {
    api = startMockApi();
    session = new McpTestSession({
      PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
      PROMIT_API_URL: api.url,
      PROMIT_CONFIG_DIR: freshConfigDir(),
    });
    await session.initialize();
  });

  afterAll(async () => {
    await session.close();
    api.stop();
  });

  test("a free prompt unlocks with no payment and arrives wrapped with attribution", async () => {
    const before = api.requests.length;
    const result = await session.callTool("promit_buy", { id: "free-hero" });
    expect(result.isError).toBeUndefined();
    expectWrapped(result, FREE_TEXT);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.tier).toBe("free");
    expect(structured.hashVerified).toBe(true);
    expect(structured.txHash).toBeUndefined();
    // No payment exchange happened: no request carried a signature.
    expect(api.requests.slice(before).every((request) => !request.hasPaymentSignature)).toBe(true);
  });

  test("AE4: a price above the per-prompt cap is refused and no signature is produced", async () => {
    const before = api.requests.length;
    const result = await session.callTool("promit_buy", { id: "paid-expensive" });
    expect(result.isError).toBe(true);
    const message = result.content[0]?.text ?? "";
    expect(message).toContain("$5.00");
    expect(message).toContain("per-prompt cap");
    expect(message).toContain("$0.10");
    expect(api.requests.slice(before).every((request) => !request.hasPaymentSignature)).toBe(true);
  });

  test("AE9: a body full of imperative directives arrives quarantined, with the tx receipt outside the block", async () => {
    const result = await session.callTool("promit_buy", { id: "paid-landing" });
    expect(result.isError).toBeUndefined();
    expectWrapped(result, PAID_TEXT);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.txHash).toBe(PAID_TX_HASH);
    expect(structured.hashVerified).toBe(true);
    expect(structured.sessionSpentUsdc).toBe("$0.05");
    // The quarantine also covers structured content: no unwrapped body copy.
    expect(JSON.stringify(structured)).not.toContain("IGNORE ALL PREVIOUS");
    const receipt = result.content[0]?.text ?? "";
    expect(receipt).toContain(`tx ${PAID_TX_HASH}`);
    expect(receipt).toContain("content hash verified");
  });

  test("a large prompt body is returned without truncation", async () => {
    const result = await session.callTool("promit_buy", { id: "paid-large" });
    expect(result.isError).toBeUndefined();
    expectWrapped(result, LARGE_TEXT);
  }, 30_000);

  test("delivered text that betrays the catalog hash is an error result that still carries the paid bytes", async () => {
    const result = await session.callTool("promit_buy", { id: "paid-tampered" });
    expect(result.isError).toBe(true);
    const message = result.content[0]?.text ?? "";
    expect(message).toContain("content hash mismatch");
    expect(message).toContain("Do not trust this content");
    expectWrapped(result, "This is not the text the catalog hash promised.");
    expect((result.structuredContent as Record<string, unknown>).hashVerified).toBe(false);
  });

  test("buying an unknown id is an error result, not a protocol failure", async () => {
    const result = await session.callTool("promit_buy", { id: "ghost" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"ghost"');
  });
});

describe("AE8: the cumulative session cap", () => {
  let api: MockApi;
  let session: McpTestSession;

  beforeAll(async () => {
    api = startMockApi();
    // Cap chosen so the first $0.05 purchase fits and the second cannot.
    session = new McpTestSession({
      PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
      PROMIT_API_URL: api.url,
      PROMIT_CONFIG_DIR: freshConfigDir(),
      PROMIT_SESSION_CAP: "0.08",
    });
    await session.initialize();
  });

  afterAll(async () => {
    await session.close();
    api.stop();
  });

  test("a purchase past the session cap is refused naming the running total and the cap", async () => {
    const first = await session.callTool("promit_buy", { id: "paid-landing" });
    expect(first.isError).toBeUndefined();
    expect((first.structuredContent as Record<string, unknown>).sessionSpentUsdc).toBe("$0.05");

    const before = api.requests.length;
    const second = await session.callTool("promit_buy", { id: "paid-large" });
    expect(second.isError).toBe(true);
    const message = second.content[0]?.text ?? "";
    expect(message).toContain("$0.05 already spent");
    expect(message).toContain("session cap of $0.08");
    expect(api.requests.slice(before).every((request) => !request.hasPaymentSignature)).toBe(true);
  });
});
