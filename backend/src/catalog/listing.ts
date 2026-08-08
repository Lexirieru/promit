import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverMessageAddress } from "viem";
import { z } from "zod";
import { computeContentHash } from "./hash.ts";
import { slugify } from "./normalize.ts";
import { CategorySchema, type MediaType } from "./schema.ts";

/**
 * Domain logika creator listing (U7).
 *
 * Identitas kreator ADALAH wallet-nya (R26): tidak ada session auth, jadi
 * satu-satunya bukti bahwa "creatorAddress" benar-benar mengirim listing ini
 * adalah tanda tangan EIP-191 atas payload kanonik di bawah. Server MENOLAK
 * listing kecuali alamat yang terpulihkan dari tanda tangan sama dengan
 * alamat yang diklaim — tanpa itu siapa pun bisa menerbitkan atas nama
 * kreator lain.
 *
 * Media WAJIB berupa upload dan melewati langkah mirror gaya U2 sebelum
 * listing terlihat: byte-nya ditulis ke storage milik Promit dan katalog
 * menunjuk `/media/...`. URL kiriman pengirim tidak pernah disimpan (R5) —
 * URL pihak ketiga berarti beacon terkendali penyerang di galeri untuk
 * setiap pengunjung, dan fetch server-side ke URL kiriman berarti SSRF ke
 * alamat internal mana pun yang disebut pengirim.
 */

// ---------------------------------------------------------------------------
// Batas harga terpublikasi (R11). Nilai atomic USDC (6 desimal), sebagai
// bigint agar perbandingan tidak pernah lewat float. Harga tanpa batas
// adalah bahaya yang sama dengan yang dijaga KTD14 dari sisi klien.

/** $0.01 — di bawah ini harga tidak menutupi keriuhan settlement-nya sendiri. */
export const MIN_PRICE_ATOMIC = 10_000n;
/** $10.00 — jauh di atas cap sesi default pembeli; lebih tinggi = jebakan. */
export const MAX_PRICE_ATOMIC = 10_000_000n;

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 100_000;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/**
 * Sub-direktori upload di dalam backend/media. Gitignored — output mirror
 * seed yang di-commit dan tulisan runtime tidak boleh bercampur di git —
 * tapi tetap di bawah `/media/*` sehingga route penyaji yang ada (dengan
 * traversal guard-nya) melayani keduanya.
 */
export const LISTING_MEDIA_SUBDIR = "uploads";
/**
 * Root that holds `uploads/`. Defaults to the committed `backend/media`, and
 * `PROMIT_UPLOADS_ROOT` moves it onto a persistent disk.
 *
 * The override exists because creator uploads are the only media written at
 * runtime: seed media is committed and returns with every build, so a host
 * that rebuilds the container loses uploads alone — the listing row survives
 * in SQLite while its preview 404s, which reads like a broken listing rather
 * than missing storage.
 *
 * It is a separate root ON PURPOSE. Mounting a volume over `backend/media`
 * would shadow the committed seed media with an empty directory and take
 * every other preview down with it. The reader in `src/index.ts` splits on
 * the same `uploads/` prefix — change one and change both.
 */
export const DEFAULT_LISTING_MEDIA_DIR =
  process.env.PROMIT_UPLOADS_ROOT ?? fileURLToPath(new URL("../../media", import.meta.url));

// ---------------------------------------------------------------------------
// Payload kanonik + pesan EIP-191

/**
 * Field yang ditandatangani kreator. `contentHash` (bukan body mentah) yang
 * masuk pesan: server menghitung ulang hash dari body yang DITERIMA lalu
 * membangun ulang pesan ini, jadi body yang diubah di tengah jalan membuat
 * pemulihan tanda tangan gagal dengan sendirinya.
 */
export interface ListingPayload {
  title: string;
  category: string;
  contentHash: string;
  priceAtomic: string;
  nonce: string;
}

/**
 * Pesan kanonik yang ditandatangani lewat personal_sign (EIP-191).
 * frontend/src/lib/listing.ts MEMBANGUN pesan yang sama — ubah format ini
 * dan setiap tanda tangan yang beredar berhenti terverifikasi, jadi jangan.
 *
 * Bebas-ambiguitas karena setiap field divalidasi satu-baris sebelum masuk:
 * title tanpa newline (skema di bawah), category dari enum, contentHash /
 * priceAtomic / nonce terkunci regex. Dua payload berbeda tidak pernah
 * menghasilkan string pesan yang sama.
 */
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
 * Alamat yang menandatangani pesan kanonik, atau null bila tanda tangan
 * tidak bisa dipulihkan sama sekali (byte rusak). Pemanggil membandingkan
 * dengan alamat yang diklaim — lowercase dua-duanya, EIP-55 hanya soal
 * kapitalisasi tampilan.
 */
export async function recoverListingSigner(
  payload: ListingPayload,
  signature: string,
): Promise<string | null> {
  try {
    return await recoverMessageAddress({
      message: canonicalListingMessage(payload),
      signature: signature as `0x${string}`,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validasi field kiriman

const SINGLE_LINE = /^[^\r\n\u2028\u2029]*$/u;

/**
 * Field teks dari form multipart, DIVERIFIKASI verbatim: tidak ada trim atau
 * normalisasi diam-diam, karena pesan kanonik dibangun dari nilai persis
 * yang ditandatangani klien — server yang "merapikan" field akan mematahkan
 * pemulihan tanda tangannya sendiri.
 */
export const ListingFieldsSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required.")
    .max(MAX_TITLE_CHARS, `Title must be at most ${MAX_TITLE_CHARS} characters.`)
    .regex(SINGLE_LINE, "Title must be a single line.")
    .refine((value) => value.trim().length > 0, "Title must not be only whitespace."),
  category: CategorySchema,
  body: z
    .string()
    .min(1, "Prompt body is required.")
    .max(MAX_BODY_CHARS, `Prompt body must be at most ${MAX_BODY_CHARS} characters.`),
  priceAtomic: z
    .string()
    .regex(/^\d{1,12}$/, "Price must be atomic USDC digits (6 decimals, no sign)."),
  nonce: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, "Nonce must be 8–128 characters of [A-Za-z0-9_-]."),
  creatorAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "Creator address must be a 0x-prefixed EVM address."),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/, "Signature must be a 65-byte 0x-prefixed hex string."),
});
export type ListingFields = z.infer<typeof ListingFieldsSchema>;

/** Batas harga terpublikasi, bentuk yang disajikan GET /v1/listings/bounds. */
export function publishedPriceBounds(): {
  minPriceAtomic: string;
  maxPriceAtomic: string;
} {
  return {
    minPriceAtomic: MIN_PRICE_ATOMIC.toString(),
    maxPriceAtomic: MAX_PRICE_ATOMIC.toString(),
  };
}

export function priceWithinBounds(priceAtomic: string): boolean {
  const price = BigInt(priceAtomic);
  return price >= MIN_PRICE_ATOMIC && price <= MAX_PRICE_ATOMIC;
}

// ---------------------------------------------------------------------------
// Id listing

/**
 * Slug deterministik dari judul, disufiks -2, -3, … sampai lolos `isTaken`.
 * `isTaken` harus memeriksa UNION seed+listing: seed menang saat tabrakan id
 * di route katalog, jadi listing yang diberi id milik seed akan terbayangi
 * selamanya — jangan pernah menerbitkan id seperti itu.
 */
export function deriveListingId(
  title: string,
  isTaken: (id: string) => boolean,
): string {
  const base = slugify(title) || "listing";
  if (!isTaken(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Media upload

export interface ClassifiedMedia {
  extension: string;
  mediaType: MediaType;
}

const DECLARED_MEDIA_TYPES: Record<string, ClassifiedMedia> = {
  "image/webp": { extension: "webp", mediaType: "image" },
  "image/png": { extension: "png", mediaType: "image" },
  "image/jpeg": { extension: "jpg", mediaType: "image" },
  "video/mp4": { extension: "mp4", mediaType: "video" },
  "video/webm": { extension: "webm", mediaType: "video" },
};

export const ACCEPTED_MEDIA_TYPES = Object.keys(DECLARED_MEDIA_TYPES);

function matchesMagic(bytes: Uint8Array, declaredType: string): boolean {
  const at = (index: number) => bytes[index] ?? -1;
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));
  switch (declaredType) {
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/png":
      return at(0) === 0x89 && ascii(1, "PNG");
    case "image/jpeg":
      return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
    case "video/mp4":
      return ascii(4, "ftyp");
    case "video/webm":
      return at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3;
    default:
      return false;
  }
}

/**
 * Klasifikasi upload dari MIME yang dideklarasikan + magic bytes isinya.
 * Magic wajib cocok: byte HTML berlabel "image/webp" yang tersaji dari
 * origin API adalah vektor XSS klasik, jadi label saja tidak pernah cukup.
 * null = tolak (tipe tak dikenal atau isi tak sesuai label).
 */
export function classifyMediaUpload(
  bytes: Uint8Array,
  declaredType: string,
): ClassifiedMedia | null {
  const declared = DECLARED_MEDIA_TYPES[declaredType.toLowerCase().split(";")[0]!.trim()];
  if (!declared) return null;
  if (!matchesMagic(bytes, declaredType.toLowerCase().split(";")[0]!.trim())) return null;
  return declared;
}

export interface MirroredListingMedia {
  media: string;
  mediaType: MediaType;
  mediaStatus: "mirrored";
  poster: null;
}

/**
 * Langkah mirror U2 untuk upload: byte mendarat di storage milik Promit
 * dengan nama deterministik `<id>.<ext>`, dan katalog menunjuk path
 * `/media/...` itu — bukan URL mana pun yang disebut pengirim. All-or-nothing
 * seperti mirror seed: gagal tulis = throw (route menjawab error yang bisa
 * diulang), tidak pernah fallback ke URL pihak ketiga.
 *
 * `poster: null` — tidak ada langkah ffmpeg saat runtime untuk mengambil
 * frame pertama; galeri menangani video tanpa poster dengan state loading.
 */
export async function mirrorListingUpload(
  id: string,
  classified: ClassifiedMedia,
  bytes: Uint8Array,
  mediaDir: string = DEFAULT_LISTING_MEDIA_DIR,
): Promise<MirroredListingMedia> {
  const uploadsDir = join(mediaDir, LISTING_MEDIA_SUBDIR);
  const fileName = `${id}.${classified.extension}`;
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(join(uploadsDir, fileName), bytes);
  return {
    media: `/media/${LISTING_MEDIA_SUBDIR}/${fileName}`,
    mediaType: classified.mediaType,
    mediaStatus: "mirrored",
    poster: null,
  };
}

// ---------------------------------------------------------------------------
// Hash konten

/**
 * Re-ekspor aturan hash terpublikasi untuk pemakai route: hash listing yang
 * disimpan HARUS dihitung fungsi yang sama dengan seed dan verifier pembeli
 * (docs/CONTENT-HASH.md) — jangan pernah implementasi kedua.
 */
export { computeContentHash };
