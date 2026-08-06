import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CatalogFile, PrivatePromptBody, PublicCatalogEntry } from "./schema.ts";
import {
  CatalogFileSchema,
  PrivatePromptBodySchema,
  PublicCatalogEntrySchema,
} from "./schema.ts";

export * from "./schema.ts";
export { computeContentHash, normalizeForHash } from "./hash.ts";
export {
  deriveTeaser,
  normalizeCategory,
  normalizeSeed,
  slugify,
  type SeedEntryDraft,
} from "./normalize.ts";
export {
  buildCatalogEntry,
  mediaFileNameFor,
  mirrorAll,
  mirrorEntry,
  toCatalogFile,
  type MirrorOptions,
  type MirrorOutcome,
} from "./mirror.ts";

export const DEFAULT_CATALOG_PATH = fileURLToPath(
  new URL("../../data/catalog.json", import.meta.url),
);

export function loadCatalogFile(path: string = DEFAULT_CATALOG_PATH): CatalogFile {
  return CatalogFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * The only shape a public route may serve. Every entry is re-parsed through
 * `PublicCatalogEntrySchema`, which has no body field and strips unknown
 * keys — so free-tier bodies present in the file are mechanically removed
 * here, not filtered by route-level discipline (KTD6 / R2).
 */
export function listPublicEntries(catalog: CatalogFile): PublicCatalogEntry[] {
  return catalog.entries.map((entry) => PublicCatalogEntrySchema.parse(entry));
}

/**
 * Free-tier body lookup for the paid/private side of the API. Paid bodies
 * are not in the catalog file at all — they live in the SQLite store (KTD17).
 */
export function getFreePromptBody(
  catalog: CatalogFile,
  id: string,
): PrivatePromptBody | null {
  const entry = catalog.entries.find((candidate) => candidate.id === id);
  if (!entry || entry.body === undefined) return null;
  return PrivatePromptBodySchema.parse({ id: entry.id, body: entry.body });
}
