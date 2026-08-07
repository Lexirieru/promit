import { API_BASE, type PublicCatalogEntry } from "@/lib/api";

/**
 * Klien untuk route creator listing U7 (/v1/listings). Path backend hidup di
 * lib/ (satu tempat, seperti api.ts) — halaman tidak pernah menyusun URL.
 *
 * Pesan kanonik EIP-191 di bawah MENCERMINKAN
 * backend/src/catalog/listing.ts (canonicalListingMessage). Server
 * membangun ulang pesan dari field yang diterima plus hash yang dihitung
 * ulang, lalu menolak listing bila alamat yang pulih bukan kreator yang
 * diklaim — ubah format di salah satu sisi dan setiap kiriman ditolak.
 */

const ENDPOINTS = {
  bounds: () => `${API_BASE}/v1/listings/bounds`,
  prepare: () => `${API_BASE}/v1/listings/prepare`,
  submit: () => `${API_BASE}/v1/listings`,
} as const;

/** Tipe media yang diterima backend (mirror ACCEPTED_MEDIA_TYPES). */
export const ACCEPTED_MEDIA_TYPES =
  "image/webp,image/png,image/jpeg,video/mp4,video/webm";

export interface ListingBounds {
  minPriceAtomic: string;
  maxPriceAtomic: string;
}

export interface ListingPayload {
  title: string;
  category: string;
  contentHash: string;
  priceAtomic: string;
  nonce: string;
}

/** Error API listing; `fields` membawa error per-field dari 400 validasi. */
export class ListingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ListingApiError";
  }
}

/** MIRROR dari backend canonicalListingMessage — jangan ubah sepihak. */
export function canonicalListingMessage(payload: ListingPayload): string {
  return [
    "promit.listing.v1",
    `title: ${payload.title}`,
    `category: ${payload.category}`,
    `contentHash: ${payload.contentHash}`,
    `priceAtomic: ${payload.priceAtomic}`,
    `nonce: ${payload.nonce}`,
  ].join("\n");
}

/**
 * "0.50" / "$0.50" → "500000" (atomic USDC, 6 desimal), null bila tak
 * valid. Menolak lebih dari 6 desimal alih-alih membulatkan — harga yang
 * ditandatangani kreator tidak boleh berbeda diam-diam dari yang diketik.
 */
export function usdcToAtomic(input: string): string | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim().replace(/^\$/, ""));
  if (!match) return null;
  const whole = match[1];
  const fraction = (match[2] ?? "").padEnd(6, "0");
  // BigInt() call, bukan literal: target tsconfig ES2017 (pilihan U1).
  return (BigInt(whole) * BigInt(1_000_000) + BigInt(fraction)).toString();
}

/** Nonce acak untuk payload kanonik; cocok regex nonce backend. */
export function randomListingNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** personal_sign menerima pesan sebagai hex byte UTF-8. */
export function hexEncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Wallet (EIP-1193). Tanpa dependensi: personal_sign adalah satu-satunya
// kebutuhan halaman listing, dan window.ethereum sudah menyediakannya.

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as { ethereum?: Eip1193Provider }).ethereum;
  return provider ?? null;
}

export async function connectWallet(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("The wallet returned no account.");
  return address;
}

export async function signListingMessage(
  provider: Eip1193Provider,
  address: string,
  message: string,
): Promise<string> {
  return (await provider.request({
    method: "personal_sign",
    params: [hexEncodeUtf8(message), address],
  })) as string;
}

// ---------------------------------------------------------------------------
// Panggilan API

async function readError(res: Response): Promise<ListingApiError> {
  try {
    const data = (await res.json()) as {
      error?: string;
      message?: string;
      fields?: Record<string, string>;
    };
    return new ListingApiError(
      res.status,
      data.error ?? "request_failed",
      data.message ?? `Request failed with status ${res.status}.`,
      data.fields,
    );
  } catch {
    return new ListingApiError(res.status, "request_failed", `Request failed with status ${res.status}.`);
  }
}

export async function fetchListingBounds(): Promise<ListingBounds> {
  const res = await fetch(ENDPOINTS.bounds(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ListingBounds;
}

export async function prepareListing(
  body: string,
): Promise<{ contentHash: string; teaser: string }> {
  const res = await fetch(ENDPOINTS.prepare(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as { contentHash: string; teaser: string };
}

/**
 * Kirim listing sebagai multipart lewat XMLHttpRequest — fetch tidak punya
 * progress upload, dan progress adalah state yang disyaratkan form (R27):
 * kreator yang mengunggah klip 8 MB harus melihat sesuatu bergerak.
 */
export function submitListing(
  form: FormData,
  onProgress: (percent: number) => void,
): Promise<PublicCatalogEntry> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ENDPOINTS.submit());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as Record<string, unknown>;
        if (xhr.status === 201) {
          resolve(data as unknown as PublicCatalogEntry);
        } else {
          reject(
            new ListingApiError(
              xhr.status,
              (data.error as string) ?? "request_failed",
              (data.message as string) ?? `Listing failed with status ${xhr.status}.`,
              data.fields as Record<string, string> | undefined,
            ),
          );
        }
      } catch {
        reject(
          new ListingApiError(xhr.status, "request_failed", `Listing failed with status ${xhr.status}.`),
        );
      }
    };
    xhr.onerror = () =>
      reject(
        new ListingApiError(
          0,
          "network_error",
          "The upload did not reach the server. Your entries are kept — retry when you're back online.",
        ),
      );
    xhr.send(form);
  });
}
