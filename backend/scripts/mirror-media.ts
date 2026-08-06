/**
 * Regenerates `backend/data/catalog.json` from the raw MotionSites capture:
 * normalizes entries, downloads every preview into `backend/media/`
 * (Promit-owned storage, R5), and rewrites media URLs to `/media/<file>`.
 *
 * Failed downloads flag the entry `unavailable` instead of keeping the
 * third-party URL, and the script still exits 0 — a missing preview is a
 * valid catalog state, a hotlink is not.
 *
 * Usage: bun run scripts/mirror-media.ts [--force]
 *   --force  redownload media even when the file already exists
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mirrorAll, normalizeSeed, toCatalogFile } from "../src/catalog/index.ts";
import { RawSeedFileSchema } from "../src/catalog/schema.ts";

const seedPath = fileURLToPath(new URL("../data/motionsites-free.json", import.meta.url));
const catalogPath = fileURLToPath(new URL("../data/catalog.json", import.meta.url));
const mediaDir = fileURLToPath(new URL("../media", import.meta.url));
const force = process.argv.includes("--force");

const seed = RawSeedFileSchema.parse(JSON.parse(readFileSync(seedPath, "utf8")));
const drafts = normalizeSeed(seed);
console.log(`Mirroring media for ${drafts.length} entries into ${mediaDir}`);

const outcomes = await mirrorAll(drafts, mediaDir, { skipExisting: !force });

for (const { entry, file, error } of outcomes) {
  if (entry.mediaStatus === "mirrored") {
    console.log(`  ok      ${entry.id} -> /media/${file}`);
  } else {
    console.warn(`  FAILED  ${entry.id}: ${error} (flagged unavailable)`);
  }
}

const catalog = toCatalogFile(seed.source, seed.capturedAt, outcomes);
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

const failed = outcomes.filter((outcome) => outcome.entry.mediaStatus === "unavailable");
console.log(
  `Wrote ${catalogPath}: ${catalog.entries.length} entries, ` +
    `${catalog.entries.length - failed.length} mirrored, ${failed.length} flagged unavailable`,
);
