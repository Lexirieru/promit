# mcp/ — Promit MCP server (U12)

Bun workspace package. `bun test` / `bun run typecheck` from this directory;
`bun src/server.ts` (or `bun run start`) is the server the host launches.
No build step: the host runs the TypeScript entry under bun.

## Shape

- `src/server.ts` — entry: resolves the signer and config **before** the
  transport starts, then `serveStdio(factory)`. The factory builds one
  `McpServer` per connection era and registers the three tools.
- `src/tools/{search,preview,buy}.ts` — `promit_search`, `promit_preview`
  (both `readOnlyHint: true`), `promit_buy` (`readOnlyHint: false`; the host
  decides confirmation from these annotations).
- `src/api.ts` — typed client for the locked API contract
  (backend/CLAUDE.md). Mirrors cli/src/api.ts because the CLI is a bin with
  no importable surface; if the contract moves, both copies move.
- `src/env.ts` — `PROMIT_PRIVATE_KEY` (named errors), `PROMIT_API_URL`,
  `PROMIT_MAX_PRICE` / `PROMIT_SESSION_CAP` (human USDC via `usdcToAtomic`).
- `src/untrusted.ts` — the nonce-delimited quarantine block (KTD20).
- `src/log.ts` — the only sanctioned writer, and it writes to stderr.

## Contracts this package keeps

- **SDK v2, pinned exact (KTD7/KTD8).** `@modelcontextprotocol/server` at
  exactly `2.0.0` — NOT `@modelcontextprotocol/sdk`; the TypeScript SDK was
  replaced 2026-07-27 by a nine-package v2 split, and every pre-August-2026
  tutorial targets v1 and misleads (v2 has no `server.tool()`, no
  `new StdioServerTransport()` hand-wiring at the entry, no `McpError`, no
  deep `sdk/server/mcp.js` imports — it is `registerTool` +
  `serveStdio(factory)`). `@x402/mcp` is skipped: it depends on the v1 SDK
  and Zod 3 and would pin the whole surface backwards. Zod 4 is imported as
  `import * as z from "zod/v4"` — the same specifier the SDK core uses.
- **Legacy protocol serving stays ON (KTD9).** `legacy: 'serve'` is the
  serveStdio default, pinned explicitly: Claude Code opens with a legacy
  `initialize` negotiating `2025-11-25`; `legacy: 'reject'` refuses the only
  client that matters. The MCP inspector negotiates the current protocol and
  NEVER exercises this path — which is why the tests speak the legacy
  handshake as a subprocess, and why U12's verification included a real
  Claude Code session (headless: `claude -p --mcp-config … --strict-mcp-config`),
  not just the inspector.
- **stdout is the protocol channel.** Every log line goes through
  `src/log.ts` to stderr. The test suite retains every raw stdout line of a
  full session and asserts each parses as JSON-RPC — that is the only net
  that catches a stray `console.log`.
- **Key from `PROMIT_PRIVATE_KEY` only (KTD15).** stdin carries JSON-RPC so
  a password prompt is impossible; the named startup errors
  (`MissingPrivateKeyError` / `InvalidPrivateKeyError`, exit 1 before the
  transport starts) exist so nobody reaches for a literal key in a committed
  `.mcp.json`. The error message says to use an env reference.
- **Caps and payment come from `@promit/x402-client` only (KTD14/KTD19).**
  `createPromitFetch` per buy call; the disk-backed `SpendLedger` (under
  `PROMIT_CONFIG_DIR`, shared with the CLI) carries the session total across
  restarts and across surfaces. Caps configure via env, never via tool
  arguments — an agent that can pass itself a bigger cap has no cap. No cap
  logic is re-implemented here; refusals surface as `isError` tool results
  whose message (from the shared error classes) names the amounts and caps
  (AE4/AE8).
- **Purchased text is quarantined (KTD20/R25/AE9).** The body returns inside
  `<<<PROMIT_UNTRUSTED_DATA <nonce>>>>` … `<<<END_PROMIT_UNTRUSTED_DATA
  <nonce>>>>` with the warning sentence outside the block. The nonce is
  minted per call, after the seller's bytes exist, so no body can close the
  block. `structuredContent` carries metadata only — repeating the text
  there would hand the session an unwrapped copy.
- **Hash mismatch is an error result that still delivers.** The buyer paid,
  so the bytes are included (wrapped), but `isError: true` with both hashes
  named — delivered-yet-unproven must not read as clean success (mirrors the
  CLI's emit-then-exit-1).

## Traps learned building this

- **The SDK turns thrown handler errors into `isError` results** and skips
  output-schema validation for them — so refusal results need no
  schema-shaped `structuredContent`, and invalid tool arguments come back as
  an error result ("Input validation error…") without the handler running.
- **The stdio transport's only size knob is `maxBufferSize`** (single-message
  ceiling, default 10 MB), set via
  `serveStdio(factory, { transport: new StdioServerTransport(undefined,
  undefined, { maxBufferSize }) })`. Raised to 64 MB for large bought bodies;
  there is no per-tool result-size option in 2.0.0.
- **The inspector CLI (v2.1.0) mis-parses inline `-e`/target invocations**
  ("No servers found in config file"); use `--config <file> --server <name>`
  instead. The old `@modelcontextprotocol/inspector-cli` v1 npx shim is
  broken outright.
- **`import.meta.main` guards the entry** so tests import
  `createPromitMcpServer` and the env helpers without starting a transport.

## Tests (`bun test`, 26)

Integration tests run the server as a real subprocess over real pipes
(`test/helpers.ts` `McpTestSession`), opening with the legacy `initialize`
at `2025-11-25` — the Claude Code path. The mock backend (adapted from
cli/test/helpers.ts) speaks the locked API contract plus the real x402 v2
wire; cap refusals are proven by the absence of any `PAYMENT-SIGNATURE`
request at the mock, not by peeking at internals. Fixtures include an
over-cap prompt (AE4), a directive-laden body (AE9 — the paid text IS a
prompt-injection attempt), a 2 MB body (no truncation), and a listing whose
delivered text betrays its catalog hash. The child env is rebuilt from
scratch so ambient `PROMIT_*` can't steer a test.
