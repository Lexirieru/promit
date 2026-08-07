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
  detail page's unlock control is U6's `UnlockButton` (see the wallet
  section below); free entries use `CopyPromptButton`.
- The category pills render the full canonical list (mirrors backend
  `CategorySchema`) — including empty categories, which is what makes the
  gallery's empty state reachable. New backend category ⇒ update
  `CATEGORIES` in `api.ts`.
- `react-hooks/set-state-in-effect` is enforced: no synchronous setState
  inside effects. Patterns already in use: `useSyncExternalStore` for
  matchMedia, id-keyed state that derives back to pending on param change
  (detail page), attempt counters bumped in event handlers (retry).

## Wallet + x402 unlock (U6)

- Stack: Reown AppKit ON TOP OF wagmi 3 + viem + TanStack Query — AppKit
  wraps wagmi, it does not replace it. `src/lib/wagmi.ts` holds the
  `WagmiAdapter` (Base Sepolia ONLY — the shared client's policy filter
  refuses every other network, so more chains would only manufacture
  wrong-chain states; networks imported from `@reown/appkit/networks`, an
  explicit `http()` transport keeps the chain's default public RPC instead
  of Reown's proxy) and exports its `wagmiConfig`; `src/app/providers.tsx`
  mounts WagmiProvider + QueryClient in the root layout. Keep every
  `@reown/appkit*` package on the SAME version — mixed versions fail at
  runtime, not install time.
- `src/lib/appkit.ts` calls `createAppKit` ONCE at module scope (inside a
  component it would re-run per render and corrupt modal state) and is
  imported for its side effect by `providers.tsx` — module evaluation
  order is the init-before-render guarantee. It is a deliberate test seam:
  suites that mount the real `Providers` mock this module away. Email and
  social login are OFF (`features`): embedded wallets hold no Base Sepolia
  USDC, so those options are dead ends dressed up as choices.
  `allowUnsupportedChain: true` is REQUIRED: without it a wallet already
  connected on another chain trips an unclosable "Switch Network" modal on
  every page (verified in a live browser) — free prompts need no wallet,
  and wrong-chain already has its inline home on `UnlockButton`.
  `NEXT_PUBLIC_REOWN_PROJECT_ID` (documented in the root `.env.example`)
  falls back to Reown's published localhost-only id so fresh checkouts
  build; deployments must set the real id.
- `WalletButton` opens the AppKit modal (`useAppKit().open()`) — wallet
  choice (MetaMask, Coinbase, WalletConnect QR), connection progress, and
  connection errors are the MODAL's states now, not the button's. The
  button keeps only disconnected (open modal) and connected (truncated
  address + disconnect). No cookie hydration: `ssr: true` without
  `cookieToInitialState` is intentional — server and first client render
  both say "disconnected", same as U6 shipped.
- `src/lib/unlock.ts` is the ONLY bridge to `@promit/x402-client` (KTD19).
  It supplies exactly what the package can't give a browser: a
  sessionStorage spend ledger (injected via `createPromitFetch`'s `ledger`
  option — corrupt values still fail CLOSED with the shared
  `SpendLedgerCorruptError`) and a wagmi signer adapter (the client needs
  only `address` + `signTypedData`). NEVER re-implement the policy filter
  or cap flow here; `unlockPrompt` sets the per-prompt cap to the
  ADVERTISED `priceAtomic`, so a 402 demanding more than the catalog
  showed is refused by the shared filter before any signature.
- Wallet rejection (EIP-1193 code 4001, walked through the `cause` chain)
  is detected at the signer seam inside `unlockPrompt` because
  `@x402/fetch` re-wraps downstream errors into plain `Error`s. Callers
  get `SignatureRejectedError` / `UnlockFailedError` / the package's
  `PaymentRefusedError` family; a content-hash mismatch does NOT throw —
  it returns text + failed check so the UI can show both.
- `UnlockButton` invariants (design review, do not weaken):
  - The "signature, not a transaction, no gas" message is INLINE copy on
    the control, rendered in every pre-unlock state BEFORE the wallet
    dialog opens. Never demote it to a tooltip.
  - `settling` is a named state between signature and the verify+settle
    answer; past 5 s it says the wait is real instead of spinning mutely.
  - Delivered text is hashed against the hash advertised BEFORE purchase
    (server-reported hash alone would only prove self-consistency); a
    mismatch renders as a `role="alert"` box naming both hashes.
  - Rejection returns to idle with an explanation; settle failure leaves
    the prompt locked; wrong chain offers `switchChain` to Base Sepolia;
    disconnected renders `WalletButton` instead of erroring.
- Build traps: the package's file ledger imports `node:fs`/`os`/`path` at
  module top level and Turbopack REFUSES Node builtins in browser chunks,
  so next.config.ts aliases them (browser condition only) to
  `src/lib/node-builtin-stub.ts`, whose exports throw if ever called.
  The package's BigInt literals also force `tsconfig target >= ES2020`.
  A stale `.next` cache can replay old typecheck diagnostics after a
  tsconfig change — `rm -rf .next` before concluding the fix didn't work.
  AppKit's wagmi adapter drags in `@coinbase/cdp-sdk` (via the Base
  account connector's Node entry), whose SVM path lazily imports the
  uninstalled optional `@x402/svm`; Turbopack resolves dynamic imports
  statically during SSR bundling and fails the build, so next.config.ts
  lists the sdk in `serverExternalPackages` — Node would only resolve that
  import if an SVM payment were ever signed, which never happens here.
- Test seams mirror the layering: `unlock-flow.test.ts` runs the REAL
  shared-client machinery (mock signer + fetch stub speaking v2
  `PAYMENT-REQUIRED` headers via `@x402/core/http`, a devDependency pinned
  at 2.21.0 for exactly this); `unlock-button.test.tsx` mocks wagmi at
  the hook boundary and `@/lib/unlock` via partial `vi.mock` so the real
  error classes keep working with `instanceof`. `prompt-detail.test.tsx`
  renders under the real `Providers` — jsdom has no injected wallet,
  which is precisely the disconnected state it asserts. jsdom cannot
  drive the real AppKit modal (and its init fetches remote config the
  fetch stubs would garble), so every suite that reaches `WalletButton`
  stubs `@reown/appkit/react`'s `useAppKit`, and `prompt-detail.test.tsx`
  additionally mocks `@/lib/appkit` to keep `createAppKit` out of jsdom
  while the real wagmi provider machinery stays live.

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
