# cli/ — Promit CLI (U11)

Bun workspace package. `bun test` / `bun run typecheck` / `bun run build`
from this directory. The build gate is `node dist/cli.js --help` listing all
five subcommands — node, never bun (KTD11).

## Shape

- `src/cli.ts` — citty entry with **lazy** subcommands (KTD10): `search`,
  `preview`, `buy`, `verify`, `wallet`. `bun build src/cli.ts --target node
  --format esm --minify` bundles everything (1.1 MB) so every dependency is a
  devDependency and the published artifact has **zero runtime deps**.
- `src/banner.ts` — gradient figlet banner, bare invocation only.
- `src/api.ts` — typed client for the locked API contract (backend/CLAUDE.md).
- `src/registry.ts` — read-only PromitRegistry view for `verify`.
- `src/wallet/keystore.ts` — key custody (KTD15).
- `src/output.ts` — the stdout/stderr split, see below.

## Contracts this package keeps

- **stdout carries data, stderr carries chrome.** `buy` prints the purchased
  text (and nothing else) to stdout so `promit buy id --yes > prompt.txt`
  captures exactly the content; receipts, spinners, warnings, and errors all
  go to stderr. On a content-hash mismatch the text is still emitted but the
  exit code is 1 — pipelines must see the failure even though bytes flowed.
- **`buy` without `--yes` on a non-interactive stdin fails immediately**
  (before any wallet or payment work) with an error naming `--yes`. A prompt
  nobody can answer would hang an unattended pipeline forever; the guard runs
  right after the catalog fetch so the free tier — which needs no
  confirmation, wallet, or payment — still works unattended.
- **Caps and payment come from `@promit/x402-client` only** (KTD14/KTD19).
  The interactive confirmation lives in `onBeforePaymentCreation` (abort with
  `{ abort: true, reason }`); `--max-price` / `--session-cap` parse through
  `usdcToAtomic`, which refuses >6 decimals. Never hand-roll cap checks here.
- **`verify` anchors on the chain, not on Promit.** A numeric ref reads
  `getListing(n)` directly over RPC (proxy
  `0x30c92fFadAd24Ca079227A92A33b78683D36Fde6`). A catalog slug is located by
  scanning listings (capped at 500) for a metadataURI whose *terminal
  segment* is the id — boundary-anchored so "hero" never claims
  "hero-section" — falling back to digest equality with the catalog claim.
  Only when no listing exists does it compare against the catalog's own
  claim, and it says out loud that this trusts Promit. U10 owns the
  metadataURI convention; if it lands with a different shape, update
  `metadataMatchesPrompt`.
- **Key resolution: `PROMIT_PRIVATE_KEY` > encrypted keystore** under
  `~/.config/promit/keystores/<name>.json` (`PROMIT_CONFIG_DIR` moves the
  root, `PROMIT_KEYSTORE`/`--keystore` picks the name). Permission bits are
  checked **before** the file is read; anything group/world-accessible
  (mode & 077) is refused with the fix (`chmod 600`) named. ethers@6 is
  imported for `encryptKeystoreJson`/`decryptKeystoreJson` only — viem has no
  keystore support (KTD15); everything else stays viem.

## Traps learned building this

- **citty 0.2.2 runs the parent `run()` after a matched subcommand.** The
  bare-invocation banner+usage in `cli.ts` is guarded on `rawArgs` or every
  `promit wallet show` would print the main usage after its output.
- **figlet fonts** load via `import font from "figlet/fonts/ANSI Shadow"` —
  no `.js` suffix; figlet 1.11.4 maps `./fonts/*` to `importable-fonts/*.js`
  and ships its own `.d.ts`, so typechecking works and `@types/figlet` must
  NOT be installed (stale, different type names, KTD12). `textSync` with an
  unregistered font reads `.flf` from disk and ENOENTs once bundled —
  always `parseFont` first.
- **bun build preserves the entry file's shebang.** `src/cli.ts` starts with
  `#!/usr/bin/env node` and that line survives minification as line 1; bun
  ignores it during `bun src/cli.ts` development runs.
- **Colour is picocolors everywhere** (KTD13): bun's `node:util.styleText`
  ignores NO_COLOR and TTY detection. The banner suppression itself
  (`shouldShowBanner`) treats NO_COLOR presence — even empty — as opt-out,
  and console-table-printer gets `shouldDisableColors` off the same signals.
- **The empty search state is words, not a table frame** (R27): zero rows
  print "No prompts match …", never an empty grid.

## Tests (`bun test`, 40)

Integration tests run the CLI as a real subprocess (`test/helpers.ts
runCli`): stdin is a non-TTY by construction — exactly the unattended
condition the buy guard exists for — and the child env is rebuilt from
scratch so ambient `PROMIT_*`/`NO_COLOR` can't steer a test. The mock
backend speaks the real x402 v2 wire (402 + `PAYMENT-REQUIRED` header via
`encodePaymentRequiredHeader`, success carries text + contentHash + txHash);
the mock registry answers `eth_call` by decoding/encoding with the same ABI
`verify` uses. Keystore tests weaken scrypt (`N: 1 << 10`) — ethers'
default costs ~1s per call. The bundle test copies `dist/cli.js` into a bare
temp dir with only `{"type":"module"}` beside it (node treats bare `.js` as
CJS otherwise) and runs it under plain node: any surviving import would fail
to resolve there, which is the zero-runtime-deps proof.

The banner's *shown* case is unit-tested through `renderBanner({ isTTY:
true, … })` — a subprocess can't get a TTY in CI. Colour escapes are not
asserted: gradient-string's chalk drops them when the test process itself
has no TTY.
