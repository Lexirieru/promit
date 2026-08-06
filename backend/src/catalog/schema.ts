import { z } from "zod";

/**
 * The catalog is split into a PUBLIC face and a PRIVATE body on purpose.
 *
 * The competitor this project studies (MotionSites) shipped its entire prompt
 * library inside the client bundle, with the paywall enforced only in the UI.
 * Promit's defence is mechanical, not disciplinary: the public entry type has
 * no field that can hold prompt text, so a route that serializes public
 * entries cannot leak a body even by accident. Prompt text only travels
 * through `PrivatePromptBody`, which public routes must never import.
 */

export const CategorySchema = z.enum([
  "Landing Page",
  "Hero",
  "3D Website",
  "Finance",
  "Wellness",
  "Fashion",
  "Portfolio",
  "Travel",
  "Agency",
]);
export type Category = z.infer<typeof CategorySchema>;

export const MediaTypeSchema = z.enum(["image", "video"]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const TierSchema = z.enum(["free", "paid"]);
export type Tier = z.infer<typeof TierSchema>;

/**
 * `mirrored`: the preview file lives in Promit-owned storage and `media`
 * is a Promit-relative path (`/media/<file>`).
 * `unavailable`: the download failed; `media` is null. We flag instead of
 * keeping the third-party URL so a broken mirror can never silently
 * reintroduce a dependency on the competitor's bucket (R5).
 */
export const MediaStatusSchema = z.enum(["mirrored", "unavailable"]);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

export const AttributionSchema = z.object({
  /** Human-readable origin of the prompt, e.g. "motionsites.ai". */
  source: z.string().min(1),
  /** ISO timestamp of the capture the entry was seeded from. */
  capturedAt: z.string().min(1),
  /** Licensing / provenance note shown alongside the entry. */
  note: z.string().min(1),
});
export type Attribution = z.infer<typeof AttributionSchema>;

/**
 * The public face of a catalog entry. Safe to serialize on any
 * unauthenticated route. MUST NOT grow a field that carries prompt text —
 * the teaser is derived from the first sentence or two, never the body.
 */
export const PublicCatalogEntrySchema = z.object({
  /** Stable slug derived from the title, e.g. "email-landing-page". */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  category: CategorySchema,
  /** First sentence or two of the prompt — a taste, never the whole body. */
  teaser: z.string().min(1),
  /** Promit-relative media path, or null when mirroring failed. */
  media: z.string().startsWith("/media/").nullable(),
  mediaType: MediaTypeSchema,
  mediaStatus: MediaStatusSchema,
  /**
   * Poster frame for video entries (`/media/<id>.poster.jpg`), null for
   * images. The gallery renders it while the clip loads so the grid never
   * shows an empty box (U5).
   */
  poster: z.string().startsWith("/media/").nullable(),
  /** Price in atomic USDC units (6 decimals), as a string. "0" = free. */
  priceAtomic: z.string().regex(/^\d+$/),
  tier: TierSchema,
  /** Content hash per docs/CONTENT-HASH.md, e.g. "sha256:ab12…". */
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  attribution: AttributionSchema,
});
export type PublicCatalogEntry = z.infer<typeof PublicCatalogEntrySchema>;

/**
 * The private body of an entry. Free-tier bodies live in the git-tracked
 * catalog file (KTD17); paid bodies live only in the SQLite store and must
 * never appear in `backend/data/catalog.json`.
 */
export const PrivatePromptBodySchema = z.object({
  id: PublicCatalogEntrySchema.shape.id,
  body: z.string().min(1),
});
export type PrivatePromptBody = z.infer<typeof PrivatePromptBodySchema>;

/**
 * One row of `backend/data/catalog.json`: the public face plus, for
 * free-tier entries only, the prompt body. The refinement makes a paid body
 * in the versioned file a load-time error, not a code-review catch.
 */
export const CatalogFileEntrySchema = PublicCatalogEntrySchema.extend({
  body: z.string().min(1).optional(),
}).refine((entry) => entry.tier === "free" || entry.body === undefined, {
  message: "paid bodies must live in the SQLite store, never in catalog.json",
});
export type CatalogFileEntry = z.infer<typeof CatalogFileEntrySchema>;

export const CatalogFileSchema = z.object({
  source: z.string().min(1),
  capturedAt: z.string().min(1),
  generatedBy: z.string().min(1),
  entries: z.array(CatalogFileEntrySchema),
});
export type CatalogFile = z.infer<typeof CatalogFileSchema>;

/**
 * Raw shape of `backend/data/motionsites-free.json` (the capture), accepted
 * only by the normalizer — nothing downstream should touch this type.
 */
export const RawSeedItemSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  media: z.url(),
  mediaType: MediaTypeSchema,
  tier: z.literal("free"),
  prompt: z.string().min(1),
});
export type RawSeedItem = z.infer<typeof RawSeedItemSchema>;

export const RawSeedFileSchema = z.object({
  source: z.string().min(1),
  capturedAt: z.string().min(1),
  tierFilter: z.string(),
  note: z.string(),
  count: z.number().int(),
  withVideo: z.number().int(),
  items: z.array(RawSeedItemSchema),
});
export type RawSeedFile = z.infer<typeof RawSeedFileSchema>;
