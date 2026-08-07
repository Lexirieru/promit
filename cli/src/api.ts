/**
 * Typed client for the public Promit API (contract locked, see
 * backend/CLAUDE.md): /v1/catalog, /v1/catalog/:id, /v1/prompts/:id.
 * Catalog responses never carry prompt text; text only travels through the
 * unlock route.
 */

export interface Attribution {
  source: string;
  capturedAt: string;
  note: string;
}

export interface PublicEntry {
  id: string;
  title: string;
  category: string;
  teaser: string;
  media: string | null;
  mediaType: "image" | "video";
  mediaStatus: "mirrored" | "unavailable";
  poster: string | null;
  /** Atomic USDC as a string; "0" means free. */
  priceAtomic: string;
  tier: "free" | "paid";
  /** `keccak256:<64 hex>` per docs/CONTENT-HASH.md. */
  contentHash: string;
  attribution: Attribution;
}

export interface CatalogResponse {
  entries: PublicEntry[];
  total: number;
}

/** Success body of GET /v1/prompts/:id. Paid unlocks add the tx fields. */
export interface UnlockSuccess {
  id: string;
  tier: "free" | "paid";
  text: string;
  contentHash: string;
  attribution: Attribution;
  txHash?: string;
  network?: string;
  payer?: string;
  /** True when the text came from a proven prior purchase — no new charge. */
  alreadyOwned?: boolean;
}

export const DEFAULT_API_URL = "https://promitbackend-production.up.railway.app";

/** Resolution order: --api flag > PROMIT_API_URL > localhost default. */
export function apiBaseUrl(flag?: string): string {
  const base = flag || process.env.PROMIT_API_URL || DEFAULT_API_URL;
  return base.replace(/\/+$/, "");
}

/** An error response the API produced deliberately: { error, message }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The API could not be reached at all (down, wrong URL, DNS). */
export class ApiUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `could not reach the Promit API at ${url} (${String(cause)}). ` +
        `Is the backend running? Set --api or PROMIT_API_URL to point elsewhere.`,
    );
    this.name = "ApiUnreachableError";
  }
}

async function requestJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new ApiUnreachableError(url, error);
  }
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;
  if (!response.ok) {
    const code = body?.error ?? `http_${response.status}`;
    const message = body?.message ?? `the API answered HTTP ${response.status}`;
    throw new ApiError(response.status, code, message);
  }
  if (body === null) {
    throw new ApiError(response.status, "invalid_json", `the API returned unparseable JSON from ${url}`);
  }
  return body;
}

export async function fetchCatalog(
  base: string,
  filters: { category?: string; tier?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogResponse> {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.tier) params.set("tier", filters.tier);
  const suffix = params.size > 0 ? `?${params}` : "";
  return requestJson<CatalogResponse>(`${base}/v1/catalog${suffix}`, fetchImpl);
}

export async function fetchEntry(
  base: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicEntry> {
  return requestJson<PublicEntry>(`${base}/v1/catalog/${encodeURIComponent(id)}`, fetchImpl);
}

export function unlockUrl(base: string, id: string): string {
  return `${base}/v1/prompts/${encodeURIComponent(id)}`;
}

/** For free-tier fetches; paid unlocks go through the x402-wrapped fetch. */
export async function fetchFreeUnlock(
  base: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UnlockSuccess> {
  return requestJson<UnlockSuccess>(unlockUrl(base, id), fetchImpl);
}
