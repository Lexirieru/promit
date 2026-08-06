import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SeedEntryDraft } from "./normalize.ts";
import type { CatalogFile, CatalogFileEntry } from "./schema.ts";
import { CatalogFileEntrySchema } from "./schema.ts";

/**
 * Media mirroring exists for R5: previews must be served from Promit-owned
 * storage, not the competitor's bucket. The rewrite is all-or-nothing per
 * entry — either the file landed in `destDir` and the catalog points at
 * `/media/<file>`, or the entry is flagged `unavailable` with `media: null`.
 * A third-party URL is never carried into the catalog, so an outage on our
 * side degrades to a missing preview instead of a hidden hotlink.
 */

export interface MirrorOutcome {
  entry: CatalogFileEntry;
  /** Filename written into `destDir`, or null when the download failed. */
  file: string | null;
  /** Human-readable failure reason, null on success. */
  error: string | null;
}

export interface MirrorOptions {
  fetchImpl?: typeof fetch;
  /** Reuse an existing non-empty file instead of downloading again. */
  skipExisting?: boolean;
  /**
   * Extra directories where an existing non-empty `<id>.<ext>` also counts
   * as already mirrored. Lets a fresh clone with committed, optimized media
   * skip the raw download entirely.
   */
  alsoConsiderExisting?: string[];
  timeoutMs?: number;
}

const KNOWN_EXTENSIONS = new Set(["mp4", "webm", "webp", "gif", "png", "jpg"]);
const FALLBACK_EXTENSION = { image: "webp", video: "mp4" } as const;

/** Deterministic Promit-side filename: `<entry id>.<extension>`. */
export function mediaFileNameFor(draft: SeedEntryDraft): string {
  const pathname = decodeURIComponent(new URL(draft.sourceMediaUrl).pathname);
  const extension = pathname.split(".").pop()?.toLowerCase() ?? "";
  const safeExtension = KNOWN_EXTENSIONS.has(extension)
    ? extension
    : FALLBACK_EXTENSION[draft.mediaType];
  return `${draft.id}.${safeExtension}`;
}

export async function mirrorEntry(
  draft: SeedEntryDraft,
  destDir: string,
  options: MirrorOptions = {},
): Promise<MirrorOutcome> {
  const {
    fetchImpl = fetch,
    skipExisting = true,
    alsoConsiderExisting = [],
    timeoutMs = 60_000,
  } = options;
  const fileName = mediaFileNameFor(draft);
  const destPath = join(destDir, fileName);
  const existsNonEmpty = (path: string) =>
    existsSync(path) && statSync(path).size > 0;

  let error: string | null = null;
  let mirrored = false;

  const alreadyHave = [destPath, ...alsoConsiderExisting.map((dir) => join(dir, fileName))];
  if (skipExisting && alreadyHave.some(existsNonEmpty)) {
    mirrored = true;
  } else {
    try {
      const response = await fetchImpl(draft.sourceMediaUrl, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        error = `HTTP ${response.status} from ${new URL(draft.sourceMediaUrl).host}`;
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0) {
          error = "empty response body";
        } else {
          await mkdir(destDir, { recursive: true });
          await writeFile(destPath, bytes);
          mirrored = true;
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  return {
    entry: buildCatalogEntry(draft, mirrored ? fileName : null),
    file: mirrored ? fileName : null,
    error,
  };
}

/**
 * Build the catalog row for a draft whose media either landed in
 * Promit-owned storage under `fileName` (possibly with a different
 * extension than the source, e.g. after a gif→mp4 transcode) or failed to
 * mirror (`fileName: null` → flagged `unavailable`).
 */
export function buildCatalogEntry(
  draft: SeedEntryDraft,
  fileName: string | null,
  mediaType: CatalogFileEntry["mediaType"] = draft.mediaType,
  posterFileName: string | null = null,
): CatalogFileEntry {
  const { sourceMediaUrl: _dropped, body, ...publicFields } = draft;
  return CatalogFileEntrySchema.parse({
    ...publicFields,
    mediaType,
    media: fileName === null ? null : `/media/${fileName}`,
    mediaStatus: fileName === null ? "unavailable" : "mirrored",
    poster: posterFileName === null ? null : `/media/${posterFileName}`,
    body,
  });
}

export async function mirrorAll(
  drafts: SeedEntryDraft[],
  destDir: string,
  options: MirrorOptions = {},
): Promise<MirrorOutcome[]> {
  const outcomes: MirrorOutcome[] = [];
  for (const draft of drafts) {
    outcomes.push(await mirrorEntry(draft, destDir, options));
  }
  return outcomes;
}

export function toCatalogFile(
  source: string,
  capturedAt: string,
  outcomes: MirrorOutcome[],
): CatalogFile {
  return {
    source,
    capturedAt,
    generatedBy: "backend/scripts/mirror-media.ts",
    entries: outcomes.map((outcome) => outcome.entry),
  };
}
