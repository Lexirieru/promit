import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogFileSchema } from "./schema.ts";
import type { SeedEntryDraft } from "./normalize.ts";
import { mediaFileNameFor, mirrorAll, mirrorEntry, toCatalogFile } from "./mirror.ts";

function draft(overrides: Partial<SeedEntryDraft> = {}): SeedEntryDraft {
  return {
    id: "fixture-hero",
    title: "Fixture Hero",
    category: "Hero",
    teaser: "A fixture hero section.",
    mediaType: "image",
    sourceMediaUrl:
      "https://pub-86dc5b5484314368ac5436a674b0d919.r2.dev/hero%20sections/animated%20(59).webp",
    priceAtomic: "0",
    tier: "free",
    contentHash: `keccak256:${"a".repeat(64)}`,
    attribution: {
      source: "motionsites.ai",
      capturedAt: "2026-08-06T19:05:20.629Z",
      note: "Seeded from the motionsites.ai free tier.",
    },
    body: "Full prompt body.",
    ...overrides,
  };
}

const okFetch = (async () =>
  new Response(new Uint8Array([1, 2, 3, 4]))) as unknown as typeof fetch;
const failingFetch = (async () => {
  throw new Error("connect ETIMEDOUT");
}) as unknown as typeof fetch;

const freshDir = () => mkdtempSync(join(tmpdir(), "promit-mirror-"));

describe("mediaFileNameFor", () => {
  test("derives <id>.<ext> from the source URL, decoding percent-escapes", () => {
    expect(mediaFileNameFor(draft())).toBe("fixture-hero.webp");
    expect(
      mediaFileNameFor(
        draft({
          mediaType: "video",
          sourceMediaUrl:
            "https://motionsites.ai/videos/CleanShot%202026-07-31%20at%2007.43.14.mp4",
        }),
      ),
    ).toBe("fixture-hero.mp4");
  });

  test("falls back to the media type when the extension is unrecognized", () => {
    expect(
      mediaFileNameFor(
        draft({ mediaType: "video", sourceMediaUrl: "https://cdn.example/stream" }),
      ),
    ).toBe("fixture-hero.mp4");
  });
});

describe("mirrorEntry", () => {
  test("downloads the file and rewrites media to a Promit-relative path", async () => {
    const dir = freshDir();
    const outcome = await mirrorEntry(draft(), dir, { fetchImpl: okFetch });
    expect(outcome.entry.mediaStatus).toBe("mirrored");
    expect(outcome.entry.media).toBe("/media/fixture-hero.webp");
    expect(outcome.error).toBeNull();
    expect(readFileSync(join(dir, "fixture-hero.webp")).length).toBe(4);
    // The rewritten entry has no trace of the third-party host.
    expect(JSON.stringify(outcome.entry)).not.toContain("r2.dev");
  });

  test("flags a failed download instead of keeping the third-party URL", async () => {
    const outcome = await mirrorEntry(draft(), freshDir(), { fetchImpl: failingFetch });
    expect(outcome.entry.mediaStatus).toBe("unavailable");
    expect(outcome.entry.media).toBeNull();
    expect(outcome.error).toContain("ETIMEDOUT");
    expect(JSON.stringify(outcome.entry)).not.toContain("r2.dev");
  });

  test("flags an HTTP error and an empty body the same way", async () => {
    const http403 = (async () =>
      new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const empty = (async () =>
      new Response(new Uint8Array(0))) as unknown as typeof fetch;
    const forbidden = await mirrorEntry(draft(), freshDir(), { fetchImpl: http403 });
    expect(forbidden.entry.mediaStatus).toBe("unavailable");
    expect(forbidden.error).toContain("403");
    const hollow = await mirrorEntry(draft(), freshDir(), { fetchImpl: empty });
    expect(hollow.entry.mediaStatus).toBe("unavailable");
    expect(hollow.error).toContain("empty");
  });

  test("reuses an existing non-empty file without re-downloading", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "fixture-hero.webp"), "cached");
    const outcome = await mirrorEntry(draft(), dir, { fetchImpl: failingFetch });
    expect(outcome.entry.mediaStatus).toBe("mirrored");
    expect(readFileSync(join(dir, "fixture-hero.webp"), "utf8")).toBe("cached");
  });

  test("keeps the free body on the catalog entry", async () => {
    const outcome = await mirrorEntry(draft(), freshDir(), { fetchImpl: okFetch });
    expect(outcome.entry.body).toBe("Full prompt body.");
  });
});

describe("toCatalogFile", () => {
  test("produces a schema-valid catalog with per-entry flags preserved", async () => {
    const dir = freshDir();
    const outcomes = await mirrorAll(
      [draft(), draft({ id: "broken-hero", title: "Broken Hero" })],
      dir,
      { fetchImpl: okFetch },
    );
    outcomes[1] = await mirrorEntry(
      draft({ id: "broken-hero", title: "Broken Hero" }),
      freshDir(),
      { fetchImpl: failingFetch },
    );
    const catalog = CatalogFileSchema.parse(
      toCatalogFile("motionsites.ai", "2026-08-06T19:05:20.629Z", outcomes),
    );
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries[0]!.mediaStatus).toBe("mirrored");
    expect(catalog.entries[1]!.mediaStatus).toBe("unavailable");
  });
});
