# backend/ — catalog module (U2)

Bun package. `bun test` / `bun run typecheck` / `bun run mirror` from this
directory. U3 adds the Hono server on top; U2 owns everything under
`src/catalog/`, `scripts/mirror-media.ts`, and `data/catalog.json`.

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

`computeContentHash()` in `src/catalog/hash.ts` implements the **published**
rule in `docs/CONTENT-HASH.md` (NFC → CRLF/CR→LF → edge-trim → SHA-256 →
`sha256:` + lowercase hex). The doc is the protocol: never change the
function without changing the doc, the prefix, and every stored hash in the
same commit. Tests replay the doc's Python snippet as an independent
implementation.

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
