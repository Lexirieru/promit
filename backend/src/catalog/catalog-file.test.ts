import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeContentHash } from "./hash.ts";
import { DEFAULT_CATALOG_PATH, listPublicEntries, loadCatalogFile } from "./index.ts";

/**
 * Guards the committed artifact `backend/data/catalog.json`, not the code:
 * regenerate it with `bun run mirror` if these fail after a seed change.
 */
describe("backend/data/catalog.json", () => {
  const catalog = loadCatalogFile();
  const mediaDir = fileURLToPath(new URL("../../media", import.meta.url));

  test("holds all 23 seed entries", () => {
    expect(catalog.entries).toHaveLength(23);
  });

  test("no media URL points at a third-party host", () => {
    for (const entry of catalog.entries) {
      if (entry.media !== null) {
        expect(entry.media).toStartWith("/media/");
        expect(entry.media).not.toContain("http");
      } else {
        expect(entry.mediaStatus).toBe("unavailable");
      }
    }
  });

  test("gifs were transcoded away and every video carries a poster frame", () => {
    for (const entry of catalog.entries) {
      expect(entry.media ?? "").not.toEndWith(".gif");
      if (entry.mediaType === "video" && entry.mediaStatus === "mirrored") {
        expect(entry.poster).toStartWith("/media/");
        const posterFile = join(mediaDir, entry.poster!.replace("/media/", ""));
        expect(existsSync(posterFile)).toBe(true);
        expect(statSync(posterFile).size).toBeGreaterThan(0);
      } else {
        expect(entry.poster).toBeNull();
      }
    }
  });

  test("every mirrored preview exists in Promit-owned storage", () => {
    for (const entry of catalog.entries) {
      if (entry.mediaStatus !== "mirrored" || entry.media === null) continue;
      const file = join(mediaDir, entry.media.replace("/media/", ""));
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(0);
    }
  });

  test("every entry is tier free with source attribution and a free body", () => {
    for (const entry of catalog.entries) {
      expect(entry.tier).toBe("free");
      expect(entry.priceAtomic).toBe("0");
      expect(entry.attribution.source).toBe("motionsites.ai");
      expect(entry.body?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("no paid body appears in the versioned file", () => {
    for (const entry of catalog.entries) {
      if (entry.body !== undefined) expect(entry.tier).toBe("free");
    }
  });

  test("stored content hashes recompute from the stored bodies", () => {
    for (const entry of catalog.entries) {
      expect(entry.contentHash).toBe(computeContentHash(entry.body!));
    }
  });

  test("the public payload of the real catalog leaks no prompt text", () => {
    const payload = JSON.stringify(listPublicEntries(catalog));
    expect(payload).not.toContain('"body"');
    for (const entry of catalog.entries) {
      // A distinctive slice from deep inside each body — far past anything
      // a teaser could legitimately contain.
      const distinctive = entry.body!.slice(1000, 1060);
      expect(distinctive.length).toBeGreaterThan(0);
      // Compare in JSON-escaped form so quotes/newlines in the slice cannot
      // make the check pass vacuously.
      expect(payload).not.toContain(JSON.stringify(distinctive).slice(1, -1));
    }
  });

  test("loads from the default path used by the API", () => {
    expect(DEFAULT_CATALOG_PATH.endsWith("data/catalog.json")).toBe(true);
  });
});
