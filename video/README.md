# Promit demo video

60–90s demo for the ChainHack 2026 submission, built with [Remotion](https://remotion.dev).
Output: `out/promit-demo.mp4` (1920×1080, 30 fps, ~70 s).

Soundtrack: **"Raising Me Higher"** (`public/assets/music.mp3`), used under the
[Mixkit Stock Music Free License](https://mixkit.co/license/#musicFree) — free
for video use, no attribution required, no copyrighted-music risk. Volume is
enveloped in `src/PromitDemo.tsx` (fade-in, bed at 0.55, fade-out on the end
card).

## Honesty policy

Nothing in this video is a mock-up:

- Every product frame is a **Playwright screenshot of the live site**
  (`https://promit-two.vercel.app`) stored in `public/captures/`. Remotion only
  pans/zooms over those captures — the UI is never rebuilt as components.
- The capture script **aborts if the gallery has fewer than 5 cards**, so a
  broken catalog can never be papered over (23 cards were detected at capture
  time, matching the API's 23 entries).
- The Basescan scenes show the real settlement transaction
  `0x7b62a3ae1bd835907f3f4b9541cf9b4b082c687c5267795178ad2e2c5aad6a85` and the
  buyer address page. The two highlighted claims — `tx.from` is the facilitator
  `0xd407e4…`, and the buyer `0xadE939…` holds **0 ETH** — were cross-checked
  against Base Sepolia RPC before the rects were drawn.
- The terminal scene replays a **byte-exact recording** of
  `bun cli/src/cli.ts search hero` against the live API
  (`public/captures/cli-search.ansi.txt`, captured via `script(1)` with ANSI
  colors intact).

## Re-render

```bash
cd video
bun install                # or npm install
npx remotion render PromitDemo out/promit-demo.mp4 --codec h264
```

`out/` is gitignored; the render takes a few minutes.

## Refresh the captures (optional)

Only needed if the live site changed and you want the video to match:

```bash
cd video
npx playwright install chromium
node scripts/capture.mjs
```

If the site is temporarily failing to load its catalog the script exits with an
error — re-run later instead of shipping a fake gallery.

## Re-record the CLI scene (optional)

Needs a checkout of the monorepo `main` branch with `bun install` done at its
root:

```bash
cd video
bash scripts/record-cli.sh /path/to/promit-main-checkout
```

This rewrites `public/captures/cli-search.ansi.txt` and regenerates
`src/generated/cliOutput.ts` (the module the terminal scene renders from).

## Structure

- `src/PromitDemo.tsx` — scene timeline (Hook → Landing → Gallery → Proof →
  Agent → End card)
- `src/scenes/` — one file per scene; proof rects are image-pixel coordinates
  measured on the 2× captures
- `src/components/camera.ts` — Ken-Burns camera (log-space zoom interpolation)
- `src/components/Terminal.tsx` — ANSI parser + terminal replay
- `scripts/capture.mjs` — Playwright capture of the live product + Basescan
- `scripts/record-cli.sh` — TTY recording of the real CLI
