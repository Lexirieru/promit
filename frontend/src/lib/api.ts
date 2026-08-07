/**
 * Client for the Promit backend (U3's Hono API).
 *
 * Paths and response shapes follow the U3<->U5 contract PINNED by the
 * coordinator (2026-08-07): `/v1/catalog` answers `{ entries, total }`,
 * `/v1/catalog/:id` answers a bare public entry or a 404, and prompt TEXT
 * only ever travels through `/v1/prompts/:id` (U4's x402 route — free tier
 * pays nothing). Do not diverge from that contract without a decision
 * gate; every path lives in the `ENDPOINTS` table so a change is one edit.
 * Base URL comes from `NEXT_PUBLIC_PROMIT_API_URL` (default: :3001).
 *
 * The types mirror `backend/src/catalog/schema.ts`'s PUBLIC face only.
 * Deliberately absent: any field that could carry prompt text. Full text
 * only travels through `fetchPromptText`, which calls the unlock route —
 * free-tier entries return their body with no payment (R3), paid entries
 * answer 402 and are U6's job.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_PROMIT_API_URL ?? "http://localhost:3001";

const ENDPOINTS = {
  /** Public catalog list; optional `?category=` filter. */
  catalog: () => `${API_BASE}/v1/catalog`,
  /** Public catalog detail — 404 for an unknown id. */
  catalogEntry: (id: string) => `${API_BASE}/v1/catalog/${encodeURIComponent(id)}`,
  /** Unlock route (U4): free tier returns text, paid returns 402. */
  prompt: (id: string) => `${API_BASE}/v1/prompts/${encodeURIComponent(id)}`,
  /** Delivered unlocks of one wallet — metadata only, never prompt text. */
  unlocks: (payer: string) => `${API_BASE}/v1/unlocks?payer=${encodeURIComponent(payer)}`,
} as const;

/** Canonical category list, mirroring `CategorySchema` in the backend.
 * The filter renders all of them — including ones with no entries yet, which
 * is exactly the case the gallery's empty state exists for. */
export const CATEGORIES = [
  "Landing Page",
  "Hero",
  "3D Website",
  "Finance",
  "Wellness",
  "Fashion",
  "Portfolio",
  "Travel",
  "Agency",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type MediaType = "image" | "video";
export type MediaStatus = "mirrored" | "unavailable";
export type Tier = "free" | "paid";

export interface Attribution {
  source: string;
  capturedAt: string;
  note: string;
}

export interface PublicCatalogEntry {
  id: string;
  title: string;
  category: Category;
  teaser: string;
  /** Promit-relative `/media/...` path, or null when mirroring failed. */
  media: string | null;
  mediaType: MediaType;
  mediaStatus: MediaStatus;
  /** First frame for video entries; null for images. */
  poster: string | null;
  /** Price in atomic USDC units (6 decimals) as a string; "0" = free. */
  priceAtomic: string;
  tier: Tier;
  contentHash: string;
  attribution: Attribution;
}

/** Thrown for non-OK responses so callers can branch on status (404 → not-found state). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new ApiError(res.status, `${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function fetchCatalog(category?: Category): Promise<PublicCatalogEntry[]> {
  const url = category
    ? `${ENDPOINTS.catalog()}?category=${encodeURIComponent(category)}`
    : ENDPOINTS.catalog();
  const data = await getJson<{ entries: PublicCatalogEntry[]; total: number }>(url);
  return data.entries;
}

export async function fetchCatalogEntry(id: string): Promise<PublicCatalogEntry> {
  return getJson<PublicCatalogEntry>(ENDPOINTS.catalogEntry(id));
}

/**
 * Full prompt text for a FREE entry, via the unlock route. A paid id
 * answers 402 here, which surfaces as an ApiError — the copy control is
 * only rendered for free entries, so hitting that is a bug, not a flow.
 */
export async function fetchPromptText(id: string): Promise<string> {
  const res = await fetch(ENDPOINTS.prompt(id), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new ApiError(res.status, `${res.status} unlocking ${id}`);
  const data = (await res.json()) as { body?: string; text?: string };
  const text = data.body ?? data.text;
  if (!text) throw new ApiError(res.status, `empty prompt body for ${id}`);
  return text;
}

/** One delivered unlock from GET /v1/unlocks — what a wallet already owns. */
export interface OwnedUnlock {
  id: string;
  unlockedAt: string;
  txHash: string | null;
  contentHash: string;
}

/**
 * Prompt yang sudah dibuka sebuah wallet. Daftar ini metadata belaka (tx
 * hash-nya toh publik on-chain); TEKS prompt tetap hanya keluar dari
 * `/v1/prompts/:id` dengan bukti entitlement bertanda tangan
 * (lib/entitlement.ts) — daftar ini cuma memberi tahu UI kapan menawarkan
 * jalur "sudah kamu miliki" alih-alih menagih lagi.
 */
export async function fetchOwnedUnlocks(payer: string): Promise<OwnedUnlock[]> {
  const data = await getJson<{ unlocks: OwnedUnlock[] }>(ENDPOINTS.unlocks(payer));
  return data.unlocks;
}

/** Absolute URL for a catalog `/media/...` path (media is served by the backend). */
export function mediaUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * URL of the unlock route for U6's payment client, which needs the raw URL
 * (its wrapped fetch answers the 402 itself) rather than a fetch helper.
 */
export function promptUrl(id: string): string {
  return ENDPOINTS.prompt(id);
}

/**
 * "500000" (atomic USDC, 6 decimals) → "$0.50". Cents always show two
 * digits; sub-cent precision is kept only when non-zero, so "50000" →
 * "$0.05" and "1234567" → "$1.234567".
 */
export function formatUsdc(priceAtomic: string): string {
  const MICRO = BigInt(1_000_000);
  const atomic = BigInt(priceAtomic);
  const whole = atomic / MICRO;
  const frac = (atomic % MICRO).toString().padStart(6, "0");
  const trimmed = frac.replace(/0+$/, "");
  const cents = trimmed.length <= 2 ? frac.slice(0, 2) : trimmed;
  return `$${whole}.${cents}`;
}
