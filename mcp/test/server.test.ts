import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  McpTestSession,
  TEST_PRIVATE_KEY,
  freshConfigDir,
  runServerToExit,
  startMockApi,
  type MockApi,
} from "./helpers";

/**
 * Every line the server ever wrote to stdout must be JSON-RPC. One stray
 * write corrupts the protocol channel and the host's parser dies — this is
 * the whole-session assertion, run after real traffic has flowed.
 */
function expectProtocolCleanStdout(session: McpTestSession): void {
  expect(session.rawStdoutLines.length).toBeGreaterThan(0);
  for (const line of session.rawStdoutLines) {
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    expect(parsed.jsonrpc).toBe("2.0");
  }
}

describe("startup", () => {
  test("without PROMIT_PRIVATE_KEY the server exits with the named error and touches stdout not at all", async () => {
    const { exitCode, stdout, stderr } = await runServerToExit({});
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("MissingPrivateKeyError");
    expect(stderr).toContain("PROMIT_PRIVATE_KEY");
  });

  test("a malformed PROMIT_PRIVATE_KEY is refused by name, not passed to the signer", async () => {
    const { exitCode, stderr } = await runServerToExit({ PROMIT_PRIVATE_KEY: "hunter2" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("InvalidPrivateKeyError");
  });
});

describe("stdio session over the legacy 2025-11-25 opening (the path Claude Code takes, KTD9)", () => {
  let api: MockApi;
  let session: McpTestSession;

  beforeAll(async () => {
    api = startMockApi();
    session = new McpTestSession({
      PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
      PROMIT_API_URL: api.url,
      PROMIT_CONFIG_DIR: freshConfigDir(),
    });
  });

  afterAll(async () => {
    await session.close();
    api.stop();
  });

  test("initialize negotiates 2025-11-25 and names the server", async () => {
    const response = await session.initialize("2025-11-25");
    const result = response.result as {
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: { tools?: object };
    };
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo.name).toBe("promit");
    expect(result.capabilities.tools).toBeDefined();
  });

  test("tools/list exposes exactly the three Promit tools", async () => {
    const response = await session.request("tools/list");
    const { tools } = response.result as { tools: Array<{ name: string }> };
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "promit_buy",
      "promit_preview",
      "promit_search",
    ]);
  });

  test("annotations mark search and preview read-only and buy not read-only", async () => {
    const response = await session.request("tools/list");
    const { tools } = response.result as {
      tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    };
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("promit_search")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("promit_preview")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("promit_buy")?.annotations?.readOnlyHint).toBe(false);
  });

  test("a tool called with invalid arguments returns an error result and the handler never runs", async () => {
    const before = api.requests.length;
    const result = await session.callTool("promit_buy", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    // The handler's first act is an API fetch; no new request means it never ran.
    expect(api.requests.length).toBe(before);
  });

  test("the whole session wrote JSON-RPC to stdout and nothing else", () => {
    expectProtocolCleanStdout(session);
  });
});
