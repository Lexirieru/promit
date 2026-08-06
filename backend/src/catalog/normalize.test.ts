import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeContentHash } from "./hash.ts";
import { deriveTeaser, normalizeCategory, normalizeSeed, slugify } from "./normalize.ts";

const seedPath = fileURLToPath(new URL("../../data/motionsites-free.json", import.meta.url));
const rawSeed = JSON.parse(readFileSync(seedPath, "utf8"));

describe("normalizeSeed on the real capture", () => {
  const entries = normalizeSeed(rawSeed);

  test("yields all 23 entries", () => {
    expect(entries).toHaveLength(23);
  });

  test("every entry has a non-empty teaser that is not the body", () => {
    for (const entry of entries) {
      expect(entry.teaser.length).toBeGreaterThan(0);
      expect(entry.teaser.length).toBeLessThanOrEqual(240);
      expect(entry.teaser.length).toBeLessThan(entry.body.length);
    }
  });

  test("ids are stable across runs, unique, and slug-shaped", () => {
    const again = normalizeSeed(rawSeed).map((entry) => entry.id);
    expect(entries.map((entry) => entry.id)).toEqual(again);
    expect(new Set(again).size).toBe(again.length);
    for (const id of again) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  test("category variants collapse to one canonical value", () => {
    const categories = new Set(entries.map((entry) => entry.category));
    expect(categories.has("Landing Page")).toBe(true);
    expect(categories.has("Hero")).toBe(true);
    // The raw capture spells these four ways; normalized output has no
    // trace of the variant spellings.
    expect([...categories]).not.toContain("Landing page");
    expect([...categories]).not.toContain("Hero Section");
    const count = (category: string) =>
      entries.filter((entry) => entry.category === category).length;
    expect(count("Landing Page")).toBe(5);
    expect(count("Hero")).toBe(11);
  });

  test("every seed entry is tier free, price 0, with source attribution", () => {
    for (const entry of entries) {
      expect(entry.tier).toBe("free");
      expect(entry.priceAtomic).toBe("0");
      expect(entry.attribution.source).toBe("motionsites.ai");
      expect(entry.attribution.capturedAt.length).toBeGreaterThan(0);
      expect(entry.attribution.note).toContain("free tier");
    }
  });

  test("content hash is computed over the body per the published rule", () => {
    for (const entry of entries) {
      expect(entry.contentHash).toBe(computeContentHash(entry.body));
      expect(entry.contentHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
    }
  });
});

describe("normalizeCategory", () => {
  test("collapses capture variants case-insensitively", () => {
    expect(normalizeCategory("Landing page")).toBe("Landing Page");
    expect(normalizeCategory("Landing Page")).toBe("Landing Page");
    expect(normalizeCategory("Hero")).toBe("Hero");
    expect(normalizeCategory("Hero Section")).toBe("Hero");
    expect(normalizeCategory(" hero section ")).toBe("Hero");
  });

  test("rejects unknown categories instead of passing them through", () => {
    expect(() => normalizeCategory("Prompt Injection")).toThrow(/Unknown category/);
  });
});

describe("slugify", () => {
  test("produces stable ids from titles", () => {
    expect(slugify("Email Landing Page")).toBe("email-landing-page");
    expect(slugify("3D Collectible Hero")).toBe("3d-collectible-hero");
    expect(slugify("PROMPT")).toBe("prompt");
    expect(slugify("Café — Über prompt!")).toBe("cafe-uber-prompt");
  });

  test("title collisions get deterministic suffixes", () => {
    const twin = { ...rawSeed, items: [rawSeed.items[0], rawSeed.items[0]] };
    const [first, second] = normalizeSeed(twin);
    expect(first!.id).toBe("email-landing-page");
    expect(second!.id).toBe("email-landing-page-2");
  });
});

describe("deriveTeaser", () => {
  test("takes the first sentence or two, stripped of markdown noise", () => {
    const teaser = deriveTeaser(
      "Build a **bold** hero with `motion/react`. Use a #0a0a0a background. Then 5000 more words.",
    );
    expect(teaser).toContain("Build a bold hero");
    expect(teaser).not.toContain("**");
    expect(teaser).not.toContain("`");
    expect(teaser).not.toContain("5000 more words");
  });

  test("falls back to a bounded prefix when there is no sentence punctuation", () => {
    const teaser = deriveTeaser("x".repeat(5000));
    expect(teaser.length).toBeGreaterThan(0);
    expect(teaser.length).toBeLessThanOrEqual(240);
  });
});
