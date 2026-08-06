import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { loadCatalogFile } from "../catalog/index.ts";
import { insertListing, openDb, setPaidBody, type NewListing } from "../db.ts";
import { createApp } from "../index.ts";

/**
 * Plan U3 test scenarios for the catalog routes, against the locked
 * U3<->U5 contract: /v1/catalog list shape { entries, total }, bare
 * public entry on detail, snake_case error codes, and NO body field
 * anywhere — free tier included.
 */

const catalog = loadCatalogFile();

// The exact key set the contract allows in a public entry.
const CONTRACT_KEYS = [
  "id",
  "title",
  "category",
  "teaser",
  "media",
  "mediaType",
  "mediaStatus",
  "poster",
  "priceAtomic",
  "tier",
  "contentHash",
  "attribution",
].sort();

const LISTING: NewListing = {
  id: "listing-only-entry",
  title: "Listing Only Entry",
  category: "Agency",
  teaser: "A creator-listed prompt that is not in the seed catalog.",
  media: null,
  mediaType: "image",
  mediaStatus: "unavailable",
  poster: null,
  priceAtomic: "250000",
  tier: "paid",
  contentHash: `keccak256:${"cd".repeat(32)}`,
  creatorAddress: "0x2222222222222222222222222222222222222222",
  signature: "0xsig",
};

let db: Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  app = createApp({ catalog, db });
});

describe("GET /v1/catalog", () => {
  test("returns all entries in the contract shape, with no prompt bodies", async () => {
    const res = await app.request("/v1/catalog");
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { entries: Record<string, unknown>[]; total: number };

    expect(body.total).toBe(catalog.entries.length);
    expect(body.entries).toHaveLength(catalog.entries.length);
    for (const entry of body.entries) {
      expect(Object.keys(entry).sort()).toEqual(CONTRACT_KEYS);
    }

    // Belt and braces: no seeded body text beyond the teaser appears in
    // the raw response — free text ships via /v1/prompts only. The check
    // uses the TAIL of each body because the teaser is, by design, the
    // body's first sentence or two, so a body prefix legitimately shows up.
    for (const fileEntry of catalog.entries) {
      if (fileEntry.body === undefined) continue;
      expect(fileEntry.body.length).toBeGreaterThan(fileEntry.teaser.length + 100);
      const tail = fileEntry.body.trimEnd().slice(-60);
      const fragment = JSON.stringify(tail).slice(1, -1);
      expect(raw).not.toContain(fragment);
    }
  });

  test("includes creator listings in the union", async () => {
    insertListing(db, LISTING);
    const res = await app.request("/v1/catalog");
    const body = (await res.json()) as { entries: { id: string }[]; total: number };
    expect(body.total).toBe(catalog.entries.length + 1);
    expect(body.entries.map((e) => e.id)).toContain(LISTING.id);
  });

  test("filters by category", async () => {
    const res = await app.request("/v1/catalog?category=Landing%20Page");
    const body = (await res.json()) as { entries: { category: string }[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    for (const entry of body.entries) {
      expect(entry.category).toBe("Landing Page");
    }
    const expected = catalog.entries.filter((e) => e.category === "Landing Page");
    expect(body.total).toBe(expected.length);
  });

  test("unknown category returns an empty list, not an error", async () => {
    const res = await app.request("/v1/catalog?category=Not%20A%20Category");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], total: 0 });
  });

  test("filters by tier", async () => {
    insertListing(db, LISTING);
    const res = await app.request("/v1/catalog?tier=paid");
    const body = (await res.json()) as { entries: { tier: string }[] };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const entry of body.entries) {
      expect(entry.tier).toBe("paid");
    }
  });
});

describe("GET /v1/catalog/:id", () => {
  test("known id returns the bare public entry", async () => {
    const first = catalog.entries[0]!;
    const res = await app.request(`/v1/catalog/${first.id}`);
    expect(res.status).toBe(200);
    const entry = (await res.json()) as Record<string, unknown>;
    expect(entry.id).toBe(first.id);
    expect(entry.title).toBe(first.title);
    expect(Object.keys(entry).sort()).toEqual(CONTRACT_KEYS);
  });

  test("unknown id returns 404 in the contract error shape", async () => {
    const res = await app.request("/v1/catalog/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_prompt_id");
    expect(body.message.length).toBeGreaterThan(0);
  });

  test("an id that exists only as a creator listing resolves through the same route", async () => {
    insertListing(db, LISTING);
    // Its paid body sits in the store; the detail route must not leak it.
    setPaidBody(db, LISTING.id, "the secret paid body text");
    const res = await app.request(`/v1/catalog/${LISTING.id}`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.id).toBe(LISTING.id);
    expect(entry.tier).toBe("paid");
    expect(Object.keys(entry).sort()).toEqual(CONTRACT_KEYS);
    expect(raw).not.toContain("the secret paid body text");
  });

  test("a listing cannot shadow a seed entry", async () => {
    const first = catalog.entries[0]!;
    const res = await app.request(`/v1/catalog/${first.id}`);
    const entry = (await res.json()) as { title: string };
    expect(entry.title).toBe(first.title);
  });
});
