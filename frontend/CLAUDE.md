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

## Tests

- `bun run test` → `vitest run`, config in `vitest.config.mts` (jsdom,
  `@vitejs/plugin-react`, `@` → `./src` alias mirroring tsconfig).
- Tests are colocated in `src/**/*.test.{ts,tsx}` — safe inside `src/app`
  because only special filenames become routes.
- Vitest globals are OFF: import from `vitest` explicitly, and call
  Testing Library's `cleanup` in an `afterEach` yourself (auto-cleanup needs
  a global `afterEach`, which doesn't exist here).
- `src/no-landingpage.test.ts` walks the repo to prove `landingpage/` stays
  dead; it skips `docs/` (the plan mentions the old name) and vendored dirs.

## Verification gates (all must pass before committing)

```
bun run build && bun run lint && bun run test
```
