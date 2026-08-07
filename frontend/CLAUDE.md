@AGENTS.md

# Promit frontend

The single Next app for the Promit pay-per-prompt marketplace (KTD4 — the
former `landingpage/` duplicate is deleted; do not recreate it). Next 16.3.0
with Turbopack, React 19, Tailwind 4, React Compiler enabled, bun as package
manager.

## Landing hero

- `src/app/page.tsx` composes `src/components/Nav.tsx` and
  `src/components/Footer.tsx`. Nav owns the mobile-menu state; its overlay is
  rendered as a sibling of `<nav>` so it positions against the page's
  `relative` root, not the nav bar.
- Entrance choreography: staggered elements carry inline `opacity: 0` plus
  `animate-fade-in-up` / `animate-fade-in-overlay` (defined in
  `globals.css`). The `prefers-reduced-motion` guard must SHORTEN the
  animation (near-zero duration, `forwards` fill), never `animation: none` —
  cancelling it leaves the inline `opacity: 0` in force and reduced-motion
  users see a blank page. `src/app/reduced-motion.test.tsx` enforces this;
  any new staggered element must use one of the guarded classes.
- Media policy: everything under `public/media/`, referenced root-relative.
  Never hotlink a third-party host — `src/app/page.test.tsx` fails on any
  absolute or protocol-relative media URL. `public/media/hero.mp4` is the
  old CloudFront hero transcoded to 1280x720 H.264 CRF 28, muted, faststart
  (22 MB → 1.2 MB); if you replace it, keep it in that size class.

## Gallery (U5)

- `src/lib/api.ts` is the ONLY place that knows backend paths, pinned to
  the coordinator-locked U3<->U5 contract: `/v1/catalog` answers
  `{entries, total}`, `/v1/catalog/:id` a bare public entry (404 when
  unknown), and prompt TEXT only ever travels through `/v1/prompts/:id`
  (U4's x402 route; free tier pays nothing). Don't diverge without a
  decision gate. Base URL: `NEXT_PUBLIC_PROMIT_API_URL`, default `:3001`;
  catalog media is backend-served, so `mediaUrl()` builds absolute URLs —
  the root-relative-only media test applies to the LANDING page, not here.
- The entry type mirrors only the public face of U2's schema. Never add a
  field that could carry prompt text; the copy control fetches it from
  `/v1/prompts/:id` at click time instead.
- `MediaPreview` owns every preview state by name: unavailable / poster /
  loading / playing / failed. Clips are 1–8 MB, so the video `src` is only
  attached once in view (IntersectionObserver, sticky); an error or a
  >10 s stall AFTER the poster shows degrades to poster + badge + retry,
  never an empty box. Reduced motion is a JS check here (CSS can't stop
  video autoplay): poster holds, a manual play control appears. U1's CSS
  guard still covers the entrance animations.
- Card controls are ALWAYS visible — the design review rejected
  hover-reveal because keyboard/touch/AT users never find hover-only
  actions. `prompt-card.test.tsx` walks control→card-root asserting no
  hover-hidden class; don't reintroduce `opacity-0 group-hover:*` on the
  action row. Controls carry entry-specific `aria-label`s and copy
  confirmation goes through an `aria-live` region.
- Both `/prompts` pages fetch client-side (build never needs a live
  backend) and name pending/error/empty/not-found states (R27). The
  detail page's unlock button is U5's placeholder naming the price and
  the no-gas story; U6 replaces it with the wallet flow.
- The category pills render the full canonical list (mirrors backend
  `CategorySchema`) — including empty categories, which is what makes the
  gallery's empty state reachable. New backend category ⇒ update
  `CATEGORIES` in `api.ts`.
- `react-hooks/set-state-in-effect` is enforced: no synchronous setState
  inside effects. Patterns already in use: `useSyncExternalStore` for
  matchMedia, id-keyed state that derives back to pending on param change
  (detail page), attempt counters bumped in event handlers (retry).

## Creator listing (/list, U7)

- `src/app/list/page.tsx` + `src/lib/listing.ts`. Path `/v1/listings*`
  hidup di `lib/listing.ts` (file terpisah dari `api.ts` agar tidak
  konflik dengan U6); `canonicalListingMessage()` di sana MENCERMINKAN
  `backend/src/catalog/listing.ts` — server membangun ulang pesan dari
  field yang diterima dan menolak bila alamat yang pulih bukan kreator
  yang diklaim, jadi ubah format dua-duanya atau jangan sama sekali.
- Alur submit bernama (R27): idle → preparing (hash dihitung server via
  `POST /prepare`, sekaligus deteksi duplikat sebelum tanda tangan) →
  signing (`personal_sign` via `window.ethereum` polos, tanpa dependensi
  wallet) → uploading (XMLHttpRequest, karena fetch tidak punya progress
  upload; progressbar ber-`aria-valuenow`) → success | error.
- **State error hanya mengganti fase, tidak pernah menyentuh nilai
  field** — retry melanjutkan dari isian yang sama; reset hanya lewat
  "List another prompt" setelah sukses. `page.test.tsx` mengunci ini.
- Preview hanya bisa berupa FILE upload (tidak ada field URL, R5) dengan
  checkbox atestasi R24; batas harga terpublikasi di-fetch dari
  `GET /v1/listings/bounds` dan ditegakkan dua sisi.
- Tes menstub `XMLHttpRequest` (progress/onerror adalah seam yang
  diuji), `window.ethereum`, dan fetch untuk bounds+prepare.

## Tests

- `bun run test` → `vitest run`, config in `vitest.config.mts` (jsdom,
  `@vitejs/plugin-react`, `@` → `./src` alias mirroring tsconfig).
- Tests are colocated in `src/**/*.test.{ts,tsx}` — safe inside `src/app`
  because only special filenames become routes.
- Vitest globals are OFF: import from `vitest` explicitly, and call
  Testing Library's `cleanup` in an `afterEach` yourself (auto-cleanup needs
  a global `afterEach`, which doesn't exist here).
- Gallery tests live in `src/components/__tests__/` with shared stubs in
  `helpers.ts` (fetch speaking the pinned contract, IntersectionObserver,
  matchMedia, clipboard, HTMLMediaElement.play/pause — jsdom has none of
  these). Wrap manual `io.intersect()` calls in `act()`; state set from an
  observer callback doesn't flush otherwise. `realCatalogEntries()` reads
  U2's `backend/data/catalog.json` from disk and strips bodies — the
  one-card-per-entry test runs against the real catalog, no fixture drift.
  Stick to `fireEvent`; `@testing-library/user-event` is deliberately not
  installed (keeps `package.json` free for U6's dependency additions).
- `src/no-landingpage.test.ts` walks the repo to prove `landingpage/` stays
  dead; it skips `docs/` (the plan mentions the old name) and vendored dirs.

## Verification gates (all must pass before committing)

```
bun run build && bun run lint && bun run test
```
