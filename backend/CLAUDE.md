# backend/ — Promit API (U3) di atas modul katalog (U2), unlock x402 (U4)

Bun package. `bun test` / `bun run typecheck` / `bun run dev` (server,
port 3001) / `bun run mirror` from this directory. U2 owns everything under
`src/catalog/`, `scripts/mirror-media.ts`, and `data/catalog.json`; U3 owns
`src/index.ts`, `src/routes/catalog.ts`, `src/middleware/cors.ts`,
`src/db.ts`; U4 owns `src/x402/` and `src/routes/unlock.ts`.

## API contract (U3<->U5, locked by the coordinator 2026-08-07)

The frontend hardcodes these in `frontend/src/lib/api.ts`
(`NEXT_PUBLIC_PROMIT_API_URL`, default `http://localhost:3001`). Do not
change a path or shape without a decision_gate.

- `GET /v1/catalog` → `{ entries: PublicEntry[], total }`; optional
  `?category=<name>&tier=<free|paid>`. Unknown filter values return an
  empty list, **not** an error.
- `GET /v1/catalog/:id` → bare PublicEntry; 404 for unknown ids.
- `GET /v1/prompts/:id` → the x402 unlock route (U4, see its section
  below). Free tier: 200 `{ id, tier, text, contentHash, attribution }`,
  no payment. Paid success: 200 with the same fields plus `txHash`,
  `network`, `payer` — text, tx hash, AND content hash in the body is the
  locked contract.
- `GET /health` → `{ ok: true }`.
- `GET /media/*` → committed mirror output, traversal-guarded.
- Errors are `{ error: "<snake_case_code>", message: "<sentence>" }`.
- **No `body` field in any catalog response, free tier included** — free
  text is delivered by `/v1/prompts/:id` only, so prompt text has exactly
  one delivery path.

The catalog id space is the **union** of seed entries and creator listings
(SQLite); seed wins on collision. `listingToPublicEntry()` re-parses every
listing through `PublicCatalogEntrySchema`, the same mechanical no-body
guarantee `listPublicEntries()` gives seed entries.

## CORS (the confusing-failure trap)

`src/middleware/cors.ts` exposes `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`
and allows `PAYMENT-SIGNATURE`. Browsers null out any cross-origin response
header not in `Access-Control-Expose-Headers` even though DevTools shows it
on the wire — drop the expose list and the browser payment client sees no
payment requirements and no tx hash while every request "succeeds". Keep
U4's unlock route under this same middleware (`app.use("*", …)` already
covers it).

## SQLite runtime store (`src/db.ts`, KTD17)

`data/promit.sqlite`, gitignored, WAL. Three tables, three writers:
`paid_bodies` (U4/U7 write, unlock route reads), `unlocks` (U4 writes,
U10 drains on-chain; PK `(payer, payment_nonce)` with payer lowercased on
every access so EIP-55 casing can't defeat R19 idempotency; status enum
includes `settled_but_undelivered` for U4's onAfterSettle hook), and
`listings` (U7; `content_hash` UNIQUE = duplicate detection;
`insertListing` validates via `PublicCatalogEntrySchema` **before**
writing, so an invalid listing never enters the table). Tests use
`openDb(":memory:")` and inject via `createApp({ catalog, db })`.

## Unlock route x402 (U4) — jalur uang

`src/x402/server.ts` (resource server + facilitator + hook),
`src/x402/pricing.ts` (harga per prompt dari union seed+listing),
`src/routes/unlock.ts` (rutenya), mounted `/v1/prompts` in `index.ts`.
Ditulis melawan kontrak facilitator yang DIAMATI di
`docs/ARCHITECTURE.md` §12 — baca itu dulu sebelum menyentuh file ini.

**Aturan urutan settlement (jangan pernah dibalik):** resolve body →
tulis baris unlock `pending` → settle → hook `onAfterSettle` menulis
`settled_but_undelivered` (uang sudah pindah, body belum keluar) →
deliver → `delivered`. Settlement terjadi DI DALAM handler
(`processHTTPRequest` + `processSettlement` langsung), bukan lewat
middleware `paymentMiddleware` bawaan @x402/hono: middleware itu settle
SETELAH handler menghasilkan body, sehingga (a) tx hash tak mungkin
masuk body sukses seperti yang dikunci kontrak, dan (b) body yang hilang
baru ketahuan setelah pembeli terpotong.

- `settle.success` + tx hash adalah SATU-SATUNYA sinyal unlock (R10);
  payload yang lolos verify masih bisa gagal settle. Hook afterSettle
  juga terpanggil untuk penolakan (`success:false`) — selalu cek.
- §12 traps yang sudah ditangani: facilitator HTTP 500 (skema/network
  asing) dinormalkan library jadi 402 bersih; label
  `invalid_exact_evm_insufficient_balance` BOHONG untuk tanda tangan
  rusak (errorMessage di-log server-side, tidak pernah diteruskan —
  bocor internal); `payer` di respons GAGAL cuma echo `authorization.from`
  (atribusi hanya dari respons sukses).
- Timeout `/settle` = hasil TAK TENTU (`settlement_indeterminate`, 502):
  facilitator mungkin tetap settle; baris `pending` menjaga jejak.
  Jangan pernah laporkan sebagai kegagalan bersih.
- Domain EIP-712 di `accepts[].extra` dibaca dari tabel `getDefaultAsset`
  @x402/evm dan di-assert terhadap alamat USDC yang dipin (KTD18) —
  jangan pernah tulis konstanta `name`/`version` lokal.
- Env: `PAY_TO_ADDRESS` (wallet polos, JANGAN alamat proxy registry —
  KTD3; tanpa ini paid unlock menolak 503, free tetap jalan) dan
  `FACILITATOR_URL` (default `https://x402.org/facilitator`;
  `facilitator.x402.org` di README = NXDOMAIN).
- Tes memalsukan facilitator di seam `FacilitatorClient` sehingga semua
  bentuk wire di atasnya (header PAYMENT-*, pencocokan `accepted` yang
  strict-deep-equal terhadap requirements) adalah kode library asli.
  Klien tes harus meng-echo `accepts[0]` hasil decode PAYMENT-REQUIRED
  apa adanya — ubah satu field saja dan matching gagal.

## The one rule that matters

**Public routes serialize `PublicCatalogEntry` only.** That type has no
field that can carry prompt text — the paywall (R2/KTD6) is enforced by the
type system plus `listPublicEntries()`, which re-parses every entry through
`PublicCatalogEntrySchema` and thereby strips the free-tier `body` present in
`catalog.json`. Never serve `CatalogFileEntry` or the raw catalog file from
a route; get bodies through `getFreePromptBody()` (free tier) or the SQLite
store (paid, U4's job). A paid body inside `catalog.json` is rejected at
load time by a schema refinement.

## Data flow

`data/motionsites-free.json` (raw capture, 23 entries, do not edit)
→ `normalizeSeed()` (canonical categories, slug ids, teasers, content hash)
→ `bun run mirror` (downloads raws into gitignored `.media-cache/`,
optimizes into committed `media/`, rewrites URLs)
→ `data/catalog.json` (generated — regenerate, never hand-edit; runtime
writes such as creator listings go to SQLite, not this file).

- Category variants (`Landing page`/`Landing Page`, `Hero`/`Hero Section`)
  collapse via `CATEGORY_ALIASES`; unknown categories **throw**. Adding a
  category = edit `CategorySchema` + `CATEGORY_ALIASES` deliberately.
- Ids are deterministic slugs of titles (`email-landing-page`); re-running
  the pipeline never changes an id.
- `media` is either a Promit-relative `/media/<id>.<ext>` or `null` with
  `mediaStatus: "unavailable"`. A third-party URL never enters the catalog;
  a failed download is a flag, not a fallback (R5). U3 must serve
  `backend/media/` at `/media/*`.
- Every `mediaType: "video"` entry carries `poster` (`/media/<id>.poster.jpg`),
  the clip's first frame — the gallery must show it while the video loads
  (U5/R27). Images have `poster: null`.
- `priceAtomic` is a string of atomic USDC units (6 decimals); `"0"` = free.

## Media optimization (coordinator-approved, 2026-08-07)

Raw capture media was 93 MB; the committed `media/` is ~16 MB (+posters):

- **mp4 → H.264** CRF 28, max width 1280 (aspect preserved, even dims for
  yuv420p), audio dropped, `+faststart`.
- **gif → mp4** with the same settings, `mediaType` flipped to `"video"`.
  Measured 23x smaller at better quality. GIF-as-GIF recompression is a
  **dead end**: best honest result was 0.5x with visible damage, and
  moderate settings came out *larger* than the source (the source GIFs'
  frame-differencing beats a re-encode). No entry points at `.gif`.
- **webp** (all ≤1.4 MB) copied as-is.
- The raw 93 MB stays in gitignored `.media-cache/`; never commit it.

**Machine limitation:** the homebrew ffmpeg build here has **no webp
encoder** (`libwebp_anim` absent) and `gif2webp`/`cwebp` are not installed —
gif→animated-webp is not an available path. Don't rediscover this dead end.

## Content hash

`computeContentHash()` in `src/catalog/hash.ts` renders the **published**
rule in `docs/CONTENT-HASH.md` (CRLF/CR→LF → strip trailing whitespace →
keccak256 → `keccak256:` + lowercase hex). The rule itself is imported from
`@promit/x402-client` (`hashPromptText`), never re-implemented, so the
minted hash and the buyer-side verifier (AE7) cannot diverge —
`content-hash-seam.test.ts` pins that seam, including every shipped catalog
entry. keccak256, not SHA-256, because `PromitRegistry` stores the digest as
a native EVM `bytes32` (`0x`-prefixed rendering of the same digest). The doc
is the protocol: never change the rule without changing the doc, the prefix,
and every stored hash in the same commit. Tests extract the doc's `js-sha3`
snippet and run it verbatim as an independent implementation.

## Traps learned building this

- Two seed bodies (`ai-designer-portfolio`, `3d-portfolio`) legitimately
  contain `https://motionsites.ai/...` image URLs **inside the prompt
  text** — they are content, not preview media. U14's third-party-host grep
  must check catalog `media` fields, not raw file text.
- The r2.dev GIFs send no Content-Length; sizes only appear on GET.
  `mirror-media.ts` skips existing non-empty files (both raw cache and
  committed output), so re-runs and fresh clones are cheap; `--force`
  redownloads and re-encodes.
- Keep `verbatimModuleSyntax`: type-only imports must use `import type` or
  `bun test` still runs while `tsc --noEmit` fails.
- `bun.lock` is deliberately gitignored here — U16's workspace root owns
  dependency locking once the bun workspace lands.
