import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  DEFAULT_PER_PROMPT_CAP_ATOMIC,
  DEFAULT_SESSION_CAP_ATOMIC,
  usdcToAtomic,
} from "@promit/x402-client";

/**
 * KTD15: this server reads PROMIT_PRIVATE_KEY and nothing else. It cannot
 * prompt for a keystore password — stdin is the JSON-RPC channel — and the
 * alternative an implementer reaches for is a literal key inside a committed
 * .mcp.json. A named startup error that says exactly which variable to set
 * is what keeps that from happening.
 */
export class MissingPrivateKeyError extends Error {
  constructor() {
    super(
      "PROMIT_PRIVATE_KEY is not set. The Promit MCP server takes its signing key from that " +
        "environment variable only — it cannot prompt for a password because stdin carries " +
        "JSON-RPC. Set PROMIT_PRIVATE_KEY in the environment the host launches this server " +
        "with (for .mcp.json, use an env reference like ${PROMIT_PRIVATE_KEY}, never a " +
        "literal key that would be committed).",
    );
    this.name = "MissingPrivateKeyError";
  }
}

export class InvalidPrivateKeyError extends Error {
  constructor() {
    super("PROMIT_PRIVATE_KEY is not a private key: expected 0x followed by 64 hex characters");
    this.name = "InvalidPrivateKeyError";
  }
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** The signer, from PROMIT_PRIVATE_KEY only. Throws a named error otherwise. */
export function resolveSigner(
  env: Record<string, string | undefined> = process.env,
): PrivateKeyAccount {
  const raw = env.PROMIT_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new MissingPrivateKeyError();
  }
  if (!PRIVATE_KEY_PATTERN.test(raw)) {
    throw new InvalidPrivateKeyError();
  }
  return privateKeyToAccount(raw as `0x${string}`);
}

export interface McpConfig {
  apiBase: string;
  perPromptCapAtomic: bigint;
  sessionCapAtomic: bigint;
}

export const DEFAULT_API_URL = "http://localhost:3001";

/**
 * Caps come from the environment, never from tool arguments: an agent that
 * can pass itself a bigger cap has no cap. Amounts are human USDC strings
 * ("0.10"), parsed by the same usdcToAtomic the CLI flags use, so a
 * malformed value refuses loudly at startup instead of widening silently.
 */
export function resolveConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  return {
    apiBase: (env.PROMIT_API_URL || DEFAULT_API_URL).replace(/\/+$/, ""),
    perPromptCapAtomic: env.PROMIT_MAX_PRICE
      ? usdcToAtomic(env.PROMIT_MAX_PRICE)
      : DEFAULT_PER_PROMPT_CAP_ATOMIC,
    sessionCapAtomic: env.PROMIT_SESSION_CAP
      ? usdcToAtomic(env.PROMIT_SESSION_CAP)
      : DEFAULT_SESSION_CAP_ATOMIC,
  };
}
