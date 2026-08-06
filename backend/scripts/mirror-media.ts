/**
 * Regenerates `backend/data/catalog.json` from the raw MotionSites capture:
 * normalizes entries, downloads every preview into `backend/.media-cache/`
 * (gitignored), optimizes each file into `backend/media/` (Promit-owned
 * storage, R5, committed), and rewrites media URLs to `/media/<file>`.
 *
 * Only the optimized output is committed — the ~90 MB of raw source bitrate
 * stays out of git history:
 *   - .mp4: H.264, max width 1280 (aspect ratio preserved), CRF 28, audio
 *     dropped (silent preview loops), +faststart.
 *   - .gif: transcoded to H.264 .mp4 with the same settings and the entry's
 *     mediaType flipped to "video" — measured 23x smaller than GIF at better
 *     quality, and the gallery already renders <video muted autoplay loop>
 *     for the native mp4 entries (R4). GIF-as-GIF recompression was a dead
 *     end: best honest result was 0.5x with visible damage.
 *   - every video entry gets a poster frame (`<id>.poster.jpg`) so the grid
 *     never shows an empty box while clips load (U5).
 *   - .webp previews are copied as-is (all ≤1.4 MB already).
 *
 * Without ffmpeg the script degrades to plain copies (gifs stay gifs, no
 * posters) rather than blocking; failed downloads flag the entry
 * `unavailable` instead of keeping the third-party URL. Both are valid
 * catalog states — a hotlink is not.
 *
 * Usage: bun run scripts/mirror-media.ts [--force]
 *   --force  redownload, re-optimize, and re-poster even when files exist
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCatalogEntry,
  mediaFileNameFor,
  mirrorEntry,
  normalizeSeed,
  toCatalogFile,
  type MirrorOutcome,
  type SeedEntryDraft,
} from "../src/catalog/index.ts";
import { RawSeedFileSchema } from "../src/catalog/schema.ts";

const seedPath = fileURLToPath(new URL("../data/motionsites-free.json", import.meta.url));
const catalogPath = fileURLToPath(new URL("../data/catalog.json", import.meta.url));
const cacheDir = fileURLToPath(new URL("../.media-cache", import.meta.url));
const mediaDir = fileURLToPath(new URL("../media", import.meta.url));
const force = process.argv.includes("--force");

const haveFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
if (!haveFfmpeg) {
  console.warn(
    "ffmpeg not found — copying raw files without optimization, gifs stay gifs, no posters",
  );
}

const existsNonEmpty = (path: string) => existsSync(path) && statSync(path).size > 0;

function runFfmpeg(args: string[]): boolean {
  return spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  }).status === 0;
}

/** H.264 for silent, aspect-ratio-preserving preview loops (even dims for yuv420p). */
function transcodeH264(rawPath: string, outPath: string): boolean {
  return runFfmpeg([
    "-i", rawPath,
    "-vf", "scale='2*trunc(min(1280,iw)/2)':-2",
    "-c:v", "libx264", "-preset", "slow", "-crf", "28",
    "-an", "-movflags", "+faststart", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

/** First frame of the final clip; false (→ poster null) when unavailable. */
function ensurePoster(videoPath: string, posterName: string): boolean {
  const posterPath = join(mediaDir, posterName);
  if (!force && existsNonEmpty(posterPath)) return true;
  if (!haveFfmpeg) return false;
  return runFfmpeg(["-i", videoPath, "-frames:v", "1", "-q:v", "4", posterPath]);
}

interface OptimizeResult {
  finalName: string;
  before: number;
  after: number;
  method: string;
}

/** Produce the committed file in media/ from the raw download in cache/. */
function optimizeInto(rawName: string, finalName: string): OptimizeResult {
  const raw = join(cacheDir, rawName);
  const final = join(mediaDir, finalName);
  const before = statSync(raw).size;
  const gifToMp4 = rawName.endsWith(".gif") && finalName.endsWith(".mp4");

  if (!force && existsNonEmpty(final)) {
    return { finalName, before, after: statSync(final).size, method: "cached" };
  }

  mkdirSync(mediaDir, { recursive: true });
  let method = "copy";

  if (haveFfmpeg && finalName.endsWith(".mp4")) {
    const temp = `${final}.tmp.mp4`;
    const ok = transcodeH264(raw, temp);
    // A gif→mp4 result is kept unconditionally (copying the gif would be the
    // wrong format); an mp4→mp4 result only when it actually shrank.
    if (ok && existsNonEmpty(temp) && (gifToMp4 || statSync(temp).size < before)) {
      renameSync(temp, final);
      const label = gifToMp4 ? "gif→h264 crf28" : "h264 crf28";
      return { finalName, before, after: statSync(final).size, method: label };
    }
    rmSync(temp, { force: true });
    if (gifToMp4) {
      // Transcode failed: fall back to committing the gif under its own name
      // so the catalog never points at a file that does not exist.
      copyFileSync(raw, join(mediaDir, rawName));
      return {
        finalName: rawName,
        before,
        after: statSync(join(mediaDir, rawName)).size,
        method: "copy (gif transcode failed)",
      };
    }
    method = ok ? "copy (transcode not smaller)" : "copy (transcode failed)";
  }

  copyFileSync(raw, final);
  return { finalName, before, after: statSync(final).size, method };
}

function plannedFinalNameFor(draft: SeedEntryDraft): string {
  const rawName = mediaFileNameFor(draft);
  return haveFfmpeg && rawName.endsWith(".gif")
    ? rawName.replace(/\.gif$/, ".mp4")
    : rawName;
}

const seed = RawSeedFileSchema.parse(JSON.parse(readFileSync(seedPath, "utf8")));
const drafts = normalizeSeed(seed);
console.log(`Mirroring media for ${drafts.length} entries into ${mediaDir}`);

const outcomes: MirrorOutcome[] = [];
const table: OptimizeResult[] = [];

for (const draft of drafts) {
  const rawName = mediaFileNameFor(draft);
  const planned = plannedFinalNameFor(draft);

  let result: OptimizeResult;
  if (!force && existsNonEmpty(join(mediaDir, planned)) && !existsNonEmpty(join(cacheDir, rawName))) {
    // Fresh clone: the committed artifact exists and there is no raw cache —
    // nothing to download or optimize.
    const size = statSync(join(mediaDir, planned)).size;
    result = { finalName: planned, before: size, after: size, method: "committed" };
  } else {
    const download = await mirrorEntry(draft, cacheDir, { skipExisting: !force });
    if (download.entry.mediaStatus === "unavailable") {
      console.warn(`  FAILED  ${draft.id}: ${download.error} (flagged unavailable)`);
      outcomes.push(download);
      continue;
    }
    result = optimizeInto(rawName, planned);
  }

  const isVideo = result.finalName.endsWith(".mp4");
  const posterName = isVideo ? `${draft.id}.poster.jpg` : null;
  const poster =
    posterName && ensurePoster(join(mediaDir, result.finalName), posterName)
      ? posterName
      : null;

  outcomes.push({
    entry: buildCatalogEntry(
      draft,
      result.finalName,
      isVideo ? "video" : draft.mediaType,
      poster,
    ),
    file: result.finalName,
    error: null,
  });
  table.push(result);
}

const megabytes = (bytes: number) => (bytes / 1e6).toFixed(2).padStart(7);
let beforeTotal = 0;
let afterTotal = 0;
console.log("\n  file                                   before MB   after MB  method");
for (const row of table) {
  beforeTotal += row.before;
  afterTotal += row.after;
  console.log(
    `  ${row.finalName.padEnd(39)}${megabytes(row.before)}   ${megabytes(row.after)}  ${row.method}`,
  );
}
console.log(`  ${"TOTAL".padEnd(39)}${megabytes(beforeTotal)}   ${megabytes(afterTotal)}\n`);

const catalog = toCatalogFile(seed.source, seed.capturedAt, outcomes);
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

const failed = outcomes.filter((outcome) => outcome.entry.mediaStatus === "unavailable");
console.log(
  `Wrote ${catalogPath}: ${catalog.entries.length} entries, ` +
    `${catalog.entries.length - failed.length} mirrored, ${failed.length} flagged unavailable`,
);
