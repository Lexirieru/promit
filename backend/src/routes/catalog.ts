import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { CatalogFile, PublicCatalogEntry } from "../catalog/index.ts";
import { listPublicEntries } from "../catalog/index.ts";
import { getListing, listListings, listingToPublicEntry } from "../db.ts";

/**
 * Public catalog routes, mounted at /v1/catalog (contract locked by the
 * coordinator, 2026-08-07). Response shapes are part of that contract:
 *
 *   GET /v1/catalog      -> { entries: PublicEntry[], total: number }
 *   GET /v1/catalog/:id  -> PublicEntry (bare)
 *   errors               -> { error: snake_case_code, message: sentence }
 *
 * No `body` field ever appears here, even for free-tier entries — free
 * text is delivered by /v1/prompts/:id (U4) only, so prompt text has one
 * delivery path, not two. Mechanically, everything served here passed
 * through PublicCatalogEntrySchema, which has no field that can carry a
 * body (KTD6/R2).
 */

export interface CatalogRouteDeps {
  catalog: CatalogFile;
  db: Database;
}

/**
 * The public id space is the union of seed entries and creator listings
 * (plan U3). Seed wins on collision: a listing must never shadow a
 * versioned catalog entry.
 */
function publicUnion({ catalog, db }: CatalogRouteDeps): PublicCatalogEntry[] {
  const seed = listPublicEntries(catalog);
  const seedIds = new Set(seed.map((entry) => entry.id));
  const listed = listListings(db)
    .filter((row) => !seedIds.has(row.id))
    .map(listingToPublicEntry);
  return [...seed, ...listed];
}

function resolveEntry(
  deps: CatalogRouteDeps,
  id: string,
): PublicCatalogEntry | null {
  const seed = listPublicEntries(deps.catalog).find((entry) => entry.id === id);
  if (seed) return seed;
  const listing = getListing(deps.db, id);
  return listing ? listingToPublicEntry(listing) : null;
}

export function catalogRoutes(deps: CatalogRouteDeps) {
  const routes = new Hono();

  routes.get("/", (c) => {
    const category = c.req.query("category");
    const tier = c.req.query("tier");
    let entries = publicUnion(deps);
    // An unknown category or tier simply matches nothing — an empty list,
    // not an error, so the gallery's filter UI never has a failure state
    // for a stale or mistyped filter value (plan U3 test scenario).
    if (category !== undefined) {
      entries = entries.filter((entry) => entry.category === category);
    }
    if (tier !== undefined) {
      entries = entries.filter((entry) => entry.tier === tier);
    }
    return c.json({ entries, total: entries.length });
  });

  routes.get("/:id", (c) => {
    const id = c.req.param("id");
    const entry = resolveEntry(deps, id);
    if (!entry) {
      return c.json(
        { error: "unknown_prompt_id", message: `No prompt with id "${id}".` },
        404,
      );
    }
    return c.json(entry);
  });

  return routes;
}
