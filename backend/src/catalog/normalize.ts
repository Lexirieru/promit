import type { Category, RawSeedFile, RawSeedItem } from "./schema.ts";
import { RawSeedFileSchema } from "./schema.ts";
import { computeContentHash } from "./hash.ts";

/**
 * A normalized seed entry before media mirroring: everything the catalog
 * needs except the final media path. `sourceMediaUrl` still points at the
 * third-party host and exists only as input to the mirror step — it must
 * never be written to `backend/data/catalog.json`.
 */
export interface SeedEntryDraft {
  id: string;
  title: string;
  category: Category;
  teaser: string;
  mediaType: RawSeedItem["mediaType"];
  sourceMediaUrl: string;
  priceAtomic: "0";
  tier: "free";
  contentHash: string;
  attribution: { source: string; capturedAt: string; note: string };
  body: string;
}

/**
 * The capture spells some categories two ways ("Landing page" vs
 * "Landing Page", "Hero" vs "Hero Section"). Lookup is case-insensitive and
 * alias-aware so the split cannot come back through later captures.
 */
const CATEGORY_ALIASES: Record<string, Category> = {
  "landing page": "Landing Page",
  hero: "Hero",
  "hero section": "Hero",
  "3d website": "3D Website",
  finance: "Finance",
  wellness: "Wellness",
  fashion: "Fashion",
  portfolio: "Portfolio",
  travel: "Travel",
  agency: "Agency",
};

export function normalizeCategory(raw: string): Category {
  const canonical = CATEGORY_ALIASES[raw.trim().toLowerCase()];
  if (!canonical) {
    throw new Error(
      `Unknown category "${raw}" — add it to CategorySchema and CATEGORY_ALIASES deliberately, not by passthrough`,
    );
  }
  return canonical;
}

/** Deterministic slug: same title in, same id out, run after run. */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const TEASER_TARGET_LENGTH = 90;
const TEASER_MAX_LENGTH = 240;
const TEASER_SCAN_WINDOW = 1200;

/**
 * First sentence or two of the body, markdown noise stripped — a taste of
 * the prompt, never the prompt. Bounded well below any real body length so
 * the teaser can sit on the public face without weakening the paywall.
 */
export function deriveTeaser(body: string): string {
  const flattened = body
    .slice(0, TEASER_SCAN_WINDOW)
    .replace(/```[a-z]*/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const sentences = flattened.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  let teaser = "";
  for (const sentence of sentences.slice(0, 2)) {
    const candidate = (teaser + sentence).trim();
    if (teaser && candidate.length > TEASER_MAX_LENGTH) break;
    teaser = candidate;
    if (teaser.length >= TEASER_TARGET_LENGTH) break;
  }
  if (!teaser) teaser = flattened.slice(0, 200).trim();
  if (teaser.length > TEASER_MAX_LENGTH) {
    teaser = `${teaser.slice(0, TEASER_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return teaser;
}

/**
 * Turn the raw capture into normalized drafts: validated input, canonical
 * categories, stable ids, teasers, and a content hash per
 * docs/CONTENT-HASH.md. Media is still the third-party URL at this stage;
 * the mirror step owns rewriting it.
 */
export function normalizeSeed(raw: unknown): SeedEntryDraft[] {
  const seed: RawSeedFile = RawSeedFileSchema.parse(raw);
  const seenIds = new Map<string, number>();

  return seed.items.map((item) => {
    const baseId = slugify(item.title);
    const collisions = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, collisions + 1);
    const id = collisions === 0 ? baseId : `${baseId}-${collisions + 1}`;

    return {
      id,
      title: item.title.trim(),
      category: normalizeCategory(item.category),
      teaser: deriveTeaser(item.prompt),
      mediaType: item.mediaType,
      sourceMediaUrl: item.media,
      priceAtomic: "0",
      tier: "free",
      contentHash: computeContentHash(item.prompt),
      attribution: {
        source: seed.source,
        capturedAt: seed.capturedAt,
        note: `Seeded from the ${seed.source} free tier; free on Promit with source attribution.`,
      },
      body: item.prompt,
    } satisfies SeedEntryDraft;
  });
}
