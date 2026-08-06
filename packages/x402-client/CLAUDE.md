# @promit/x402-client

The one payment client every Promit surface imports (KTD19). The browser
(U6), CLI (U11), and MCP server (U12) must all pay through this package —
never hand-roll a second copy of the cap logic. Depend on it with
`"@promit/x402-client": "workspace:*"` and import from the package root.

## What lives where

- `src/client.ts` — `selectPaymentRequirement` (the policy filter) and
  `createPromitFetch` (the x402-wrapped fetch).
- `src/caps.ts` — `SpendLedger`, the cumulative session budget persisted at
  `~/.config/promit/spend.json` (override: `PROMIT_CONFIG_DIR` env or the
  `configDir` option; tests must always pass an explicit temp dir).
- `src/verify.ts` — the published content-hash rule and post-unlock check.
- `src/errors.ts` — typed refusals; `src/constants.ts` — the pinned
  denomination and USDC helpers.

## Invariants (do not weaken)

1. **Denomination before amount (KTD14).** The filter rejects any requirement
   whose scheme is not `exact`, network is not `eip155:84532`, or asset is not
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — and only then compares the
   atomic amount against the caps. An under-cap amount in the wrong asset is a
   `PolicyRefusalError`, never a cap comparison: a small `amount` in an
   18-decimal token signs away far more value than a 6-decimal USDC cap
   implies.
2. **The ledger is the enforcement point.** `SpendLedger.charge()` re-reads
   the file and re-checks the session cap atomically; every earlier check is a
   courtesy for better error messages. The charge lands *before* the signature
   and is refunded only when payload creation fails — a produced signature can
   still be settled inside its validity window, so it stays counted even when
   the response is lost or the server rejects.
3. **A corrupt ledger fails closed** (`SpendLedgerCorruptError`). Treating a
   damaged file as zero would let anything that can scribble on it reset the
   budget. `reset()` exists for an explicit human decision only (e.g. a CLI
   budget command behind a confirmation) — never call it from agent code.
4. **Refusals are typed and thrown before any signature.**
   `PolicyRefusalError`, `PerPromptCapExceededError` (names both amounts,
   AE4), `SessionCapExceededError` (names the running total, AE8), all
   extending `PaymentRefusedError`. They are thrown from the *wrapped fetch*
   on the raw 402 because `@x402/fetch` re-wraps downstream errors into plain
   `Error`, which would erase the class. The same filter runs again in the
   client's selector and `onBeforePaymentCreation` hook as defense in depth.

## The published content-hash rule (R12)

CRLF and lone CR → LF; strip trailing whitespace at the end of the text;
nothing else; then keccak256 over the UTF-8 bytes (a bytes32 the registry can
store). `hashPromptText` / `verifyContentHash` / `assertContentHash` implement
it. **Backend (U2/U4) must produce hashes under this exact rule** — import
this package rather than re-implementing, or the buyer-side `promit verify`
(AE7) will report mismatches on every prompt.

## Using it from a surface

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPromitFetch, usdcToAtomic, assertContentHash } from "@promit/x402-client";

const { fetchWithPayment, ledger } = createPromitFetch({
  signer: privateKeyToAccount(key),
  perPromptCapAtomic: usdcToAtomic("0.10"),
  sessionCapAtomic: usdcToAtomic("1.00"),
  onBeforePaymentCreation: async (ctx) => {
    // CLI: interactive confirm. Return { abort: true, reason } to veto.
  },
});
const res = await fetchWithPayment(unlockUrl);
const { text, contentHash } = await res.json();
assertContentHash(text, contentHash); // throws ContentHashMismatchError on tamper
```

Caps default to $0.10 per prompt / $1.00 per session when a surface passes
nothing — a surface that forgets configuration gets safe caps, not unlimited
spend. `usdcToAtomic` rejects >6 decimals instead of rounding.

## Workspace notes (root `package.json` belongs to this unit)

- The workspace members are declared as `"{frontend,backend,cli,mcp}"` plus
  `packages/*`. The brace glob is deliberate: bun 1.3 errors on a *literal*
  workspace entry whose directory lacks a `package.json`, but silently skips
  unmatched *glob* members. `backend/`, `cli/`, and `mcp/` are picked up
  automatically the moment they gain a manifest — do not "fix" the glob back
  to literal names while any member is missing.
- bun 1.3 uses isolated installs: packages land under `node_modules/.bun`
  with per-workspace symlinks, so `ls node_modules/@x402` at the root finds
  nothing — look under `packages/x402-client/node_modules/`.
- `@x402/*` are pinned at exactly `2.21.0` (KTD1). The unscoped `x402-*` line
  is deprecated; v1 network strings (`base-sepolia`) fail v2 packages with
  `invalid_network`. Requirements here use CAIP-2 `eip155:84532` and the v2
  `amount` field (v1's `maxAmountRequired` is gone).

## x402 v2 API facts learned the hard way

- The 402 challenge arrives in a base64 `PAYMENT-REQUIRED` header
  (`encodePaymentRequiredHeader` / `getPaymentRequiredResponse`); a JSON body
  is only consulted for v1. Tests fake a server by setting that header.
- `x402Client.createPaymentPayload` runs: selector → `onBeforePaymentCreation`
  hooks (abort here = no signature) → scheme `createPaymentPayload` (this is
  where `signTypedData` happens) → after-hooks. `onPaymentCreationFailure`
  fires only for failures inside that try — before-hook throws never trigger
  it, which is exactly why charging in the before-hook needs no compensating
  refund on refusal.
- The client's internal step 1 silently drops requirements whose
  network/scheme has no registered handler and throws a generic `Error` when
  none survive — another reason the typed refusal must fire on the raw 402
  before the wrapper runs.
- EIP-712 domain fields come from `accepts[].extra` (KTD18); tests pass
  `extra: { name: "USDC", version: "2" }`.

## Verification

`cd packages/x402-client && bun test` (42 tests; mock signer counts
`signTypedData` calls to prove refusals produce zero signatures) and
`bun run typecheck`.
