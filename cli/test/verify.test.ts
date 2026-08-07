import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeFunctionData, encodeFunctionResult } from "viem";

import { hashPromptText } from "@promit/x402-client";

import { metadataMatchesPrompt, registryAbi } from "../src/registry";
import {
  PAID_TEXT,
  freshConfigDir,
  runCli,
  startMockApi,
  type MockApi,
} from "./helpers";

interface FixtureListing {
  creator: `0x${string}`;
  contentHash: `0x${string}`;
  price: bigint;
  active: boolean;
  metadataURI: string;
}

/**
 * A minimal JSON-RPC endpoint that answers the two registry reads `verify`
 * performs. Decoding with the same ABI the CLI encodes with keeps the wire
 * format honest: a drifted selector or tuple layout fails loudly here.
 */
function startMockRpc(listings: FixtureListing[]) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        id: number;
        method: string;
        params?: [{ data: `0x${string}` }, string];
      };
      const respond = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: body.id, result });
      if (body.method !== "eth_call" || !body.params) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `unsupported method ${body.method}` },
        });
      }
      const decoded = decodeFunctionData({ abi: registryAbi, data: body.params[0].data });
      if (decoded.functionName === "listingCount") {
        return respond(
          encodeFunctionResult({
            abi: registryAbi,
            functionName: "listingCount",
            result: BigInt(listings.length),
          }),
        );
      }
      const listing = listings[Number((decoded.args as readonly [bigint])[0]) - 1];
      if (!listing) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: 3, message: "execution reverted: UnknownListing" },
        });
      }
      return respond(
        encodeFunctionResult({ abi: registryAbi, functionName: "getListing", result: listing }),
      );
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

const CREATOR = "0x3333333333333333333333333333333333333333" as const;

function listingFor(text: string, metadataURI: string): FixtureListing {
  return {
    creator: CREATOR,
    contentHash: hashPromptText(text),
    price: 50000n,
    active: true,
    metadataURI,
  };
}

let api: MockApi;
beforeAll(() => {
  api = startMockApi();
});
afterAll(() => {
  api.stop();
});

function env(rpcUrl: string): Record<string, string> {
  return {
    PROMIT_API_URL: api.url,
    PROMIT_CONFIG_DIR: freshConfigDir(),
    PROMIT_RPC_URL: rpcUrl,
  };
}

describe("promit verify", () => {
  test("AE7: an untampered prompt matches the on-chain hash by numeric listing id", async () => {
    const rpc = startMockRpc([listingFor(PAID_TEXT, "promit:paid-landing")]);
    try {
      const dir = freshConfigDir();
      const file = join(dir, "delivered.txt");
      // CRLF line endings and a trailing newline are transport artifacts the
      // published rule absorbs; the hash must still match.
      writeFileSync(file, `${PAID_TEXT.replaceAll("\n", "\r\n")}\n`);
      const result = await runCli(["verify", "1", file], { env: env(rpc.url) });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("MATCH");
      expect(result.stderr).toContain("on-chain listing 1");
    } finally {
      rpc.stop();
    }
  });

  test("AE7: altered text is reported as a mismatch with both hashes shown", async () => {
    const rpc = startMockRpc([listingFor(PAID_TEXT, "promit:paid-landing")]);
    try {
      const dir = freshConfigDir();
      const file = join(dir, "tampered.txt");
      writeFileSync(file, `${PAID_TEXT} — subtly altered`);
      const result = await runCli(["verify", "1", file], { env: env(rpc.url) });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("MISMATCH");
      expect(result.stderr).toContain(hashPromptText(PAID_TEXT));
      expect(result.stderr).toContain(hashPromptText(`${PAID_TEXT} — subtly altered`));
    } finally {
      rpc.stop();
    }
  });

  test("reads the delivered text from stdin when no file is given", async () => {
    const rpc = startMockRpc([listingFor(PAID_TEXT, "promit:paid-landing")]);
    try {
      const result = await runCli(["verify", "1"], { env: env(rpc.url), stdin: PAID_TEXT });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("MATCH");
    } finally {
      rpc.stop();
    }
  });

  test("a catalog id resolves to its on-chain listing via metadataURI and verifies against the chain", async () => {
    const rpc = startMockRpc([
      listingFor("some other prompt", "promit:other"),
      listingFor(PAID_TEXT, "https://promit.example/catalog/paid-landing"),
    ]);
    try {
      const result = await runCli(["verify", "paid-landing"], {
        env: env(rpc.url),
        stdin: PAID_TEXT,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("MATCH");
      expect(result.stderr).toContain("listing 2");
    } finally {
      rpc.stop();
    }
  });

  test("with no on-chain listing it falls back to the catalog claim and says that trusts Promit", async () => {
    const rpc = startMockRpc([]);
    try {
      const result = await runCli(["verify", "paid-landing"], {
        env: env(rpc.url),
        stdin: PAID_TEXT,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("MATCH");
      expect(result.stderr).toContain("no on-chain listing");
      expect(result.stderr).toContain("trusts Promit");
    } finally {
      rpc.stop();
    }
  });

  test("an unresolvable ref with no listing and no catalog entry is a named failure", async () => {
    const rpc = startMockRpc([]);
    try {
      const result = await runCli(["verify", "no-such-prompt"], {
        env: env(rpc.url),
        stdin: "anything",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("nothing to verify against");
    } finally {
      rpc.stop();
    }
  });
});

describe("metadataMatchesPrompt", () => {
  test("matches terminal path and URN segments only", () => {
    expect(metadataMatchesPrompt("promit:hero", "hero")).toBe(true);
    expect(metadataMatchesPrompt("https://x/catalog/hero", "hero")).toBe(true);
    expect(metadataMatchesPrompt("https://x/catalog/hero.json", "hero")).toBe(true);
    expect(metadataMatchesPrompt("hero", "hero")).toBe(true);
    // Boundary-anchored: a prefix of a longer slug must not match.
    expect(metadataMatchesPrompt("promit:hero-section", "hero")).toBe(false);
    expect(metadataMatchesPrompt("https://x/catalog/hero-section", "hero")).toBe(false);
  });
});
