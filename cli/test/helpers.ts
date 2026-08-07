import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";

import {
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  hashPromptText,
} from "@promit/x402-client";

export const CLI_DIR = new URL("..", import.meta.url).pathname;

/** anvil account #0 — a public, throwaway key for offline signing in tests. */
export const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const FREE_TEXT = "  Build a hero section.\nUse React.";
export const PAID_TEXT = "PAID PROMPT: full landing page copy.\nSecond line of the paid body.";
export const PAID_TX_HASH = `0x${"11".repeat(32)}`;

export function catalogHashOf(text: string): string {
  return `keccak256:${hashPromptText(text).slice(2)}`;
}

const ATTRIBUTION = {
  source: "motionsites.ai",
  capturedAt: "2026-08-01T00:00:00Z",
  note: "seeded from the public capture",
};

interface FixtureCore {
  id: string;
  title: string;
  tier: "free" | "paid";
  priceAtomic: string;
  contentHash: string;
  category?: string;
}

function entry<T extends FixtureCore>(overrides: T) {
  return {
    category: "Hero",
    teaser: "A teaser only, never the body.",
    media: null,
    mediaType: "image",
    mediaStatus: "unavailable",
    poster: null,
    attribution: ATTRIBUTION,
    ...overrides,
  };
}

/** Catalog fixtures: one free, one affordable paid, one over-cap paid. */
export const ENTRIES = [
  entry({
    id: "free-hero",
    title: "Free hero section",
    tier: "free",
    priceAtomic: "0",
    contentHash: catalogHashOf(FREE_TEXT),
  }),
  entry({
    id: "paid-landing",
    title: "Paid landing page",
    category: "Landing Page",
    tier: "paid",
    priceAtomic: "50000",
    contentHash: catalogHashOf(PAID_TEXT),
  }),
  entry({
    id: "paid-expensive",
    title: "Expensive paid prompt",
    tier: "paid",
    priceAtomic: "5000000",
    contentHash: catalogHashOf(PAID_TEXT),
  }),
];

export interface SeenRequest {
  path: string;
  hasPaymentSignature: boolean;
}

export interface MockApi {
  url: string;
  requests: SeenRequest[];
  stop: () => void;
}

/**
 * Fake Promit backend speaking the locked API contract plus a real x402 v2
 * wire exchange: 402 + PAYMENT-REQUIRED header until PAYMENT-SIGNATURE
 * arrives, then 200 with text, contentHash, and txHash in the body — the
 * same shape backend/src/routes/unlock.ts serves.
 */
export function startMockApi(): MockApi {
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        hasPaymentSignature: request.headers.has("PAYMENT-SIGNATURE"),
      });

      if (url.pathname === "/v1/catalog") {
        let entries = ENTRIES;
        const category = url.searchParams.get("category");
        const tier = url.searchParams.get("tier");
        if (category !== null) entries = entries.filter((e) => e.category === category);
        if (tier !== null) entries = entries.filter((e) => e.tier === tier);
        return Response.json({ entries, total: entries.length });
      }

      const catalogMatch = /^\/v1\/catalog\/([^/]+)$/.exec(url.pathname);
      if (catalogMatch) {
        const found = ENTRIES.find((e) => e.id === catalogMatch[1]);
        if (!found) {
          return Response.json(
            { error: "unknown_prompt_id", message: `No prompt with id "${catalogMatch[1]}".` },
            { status: 404 },
          );
        }
        return Response.json(found);
      }

      const unlockMatch = /^\/v1\/prompts\/([^/]+)$/.exec(url.pathname);
      if (unlockMatch) {
        const found = ENTRIES.find((e) => e.id === unlockMatch[1]);
        if (!found) {
          return Response.json(
            { error: "unknown_prompt_id", message: `No prompt with id "${unlockMatch[1]}".` },
            { status: 404 },
          );
        }
        if (found.tier === "free") {
          return Response.json({
            id: found.id,
            tier: "free",
            text: FREE_TEXT,
            contentHash: found.contentHash,
            attribution: ATTRIBUTION,
          });
        }
        if (!request.headers.has("PAYMENT-SIGNATURE")) {
          return new Response(JSON.stringify({ error: "payment required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
                x402Version: 2,
                resource: { url: request.url },
                accepts: [
                  {
                    scheme: "exact",
                    network: BASE_SEPOLIA_NETWORK,
                    asset: BASE_SEPOLIA_USDC,
                    amount: found.priceAtomic,
                    payTo: "0x2222222222222222222222222222222222222222",
                    maxTimeoutSeconds: 300,
                    extra: { name: "USDC", version: "2" },
                  },
                ],
              }),
            },
          });
        }
        return Response.json(
          {
            id: found.id,
            tier: "paid",
            text: PAID_TEXT,
            contentHash: found.contentHash,
            txHash: PAID_TX_HASH,
            network: BASE_SEPOLIA_NETWORK,
            payer: "0x1111111111111111111111111111111111111111",
            attribution: ATTRIBUTION,
          },
          {
            headers: {
              "PAYMENT-RESPONSE": encodePaymentResponseHeader({
                success: true,
                transaction: PAID_TX_HASH as `0x${string}`,
                network: BASE_SEPOLIA_NETWORK,
                payer: "0x1111111111111111111111111111111111111111",
              }),
            },
          },
        );
      }

      return Response.json({ error: "not_found", message: "no such route" }, { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

export function freshConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "promit-cli-test-"));
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs the CLI as a real subprocess. stdin is a non-TTY by construction,
 * which is exactly the unattended-pipeline condition the buy guard exists
 * for. The environment is rebuilt from scratch so ambient PROMIT_* or
 * NO_COLOR values on the host can never steer a test.
 */
export async function runCli(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: CLI_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "dumb",
      ...options.env,
    },
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
