import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { CatalogFile } from "../catalog/index.ts";
import { MediaFetchError, fetchRemoteMedia } from "../catalog/fetch-media.ts";
import { listPublicEntries } from "../catalog/index.ts";
import {
  ACCEPTED_MEDIA_TYPES,
  ListingFieldsSchema,
  MAX_MEDIA_BYTES,
  classifyMediaUpload,
  computeContentHash,
  deriveListingId,
  mirrorListingUpload,
  priceWithinBounds,
  publishedPriceBounds,
  recoverListingSigner,
  type ListingFields,
} from "../catalog/listing.ts";
import { deriveTeaser } from "../catalog/normalize.ts";
import {
  findListingByContentHash,
  getListing,
  insertListing,
  listingToPublicEntry,
  setPaidBody,
} from "../db.ts";

/**
 * Route creator listing (U7), dipasang di /v1/listings.
 *
 *   GET  /v1/listings/bounds   -> batas harga terpublikasi (R11)
 *   POST /v1/listings/prepare  -> { contentHash, teaser } untuk body kiriman;
 *                                 409 bila duplikat — SEBELUM kreator
 *                                 menandatangani dan meng-upload apa pun
 *   POST /v1/listings          -> multipart; membuat listing berbayar
 *
 * Urutan penolakan di POST / disengaja: validasi field -> batas harga ->
 * duplikat -> TANDA TANGAN -> baru mirror media dan tulis SQLite. Tidak ada
 * satu byte pun mendarat di storage Promit sebelum tanda tangan terbukti
 * pulih ke kreator yang diklaim (AE10/R26).
 *
 * Bentuk error mengikuti kontrak API: { error: snake_case, message } —
 * ditambah `fields` per-field untuk 400 validasi, dan batas terpublikasi
 * untuk 400 harga.
 */

export interface ListingRouteDeps {
  catalog: CatalogFile;
  db: Database;
  /** Injeksi tes: direktori media pengganti backend/media. */
  mediaDir?: string;
  /**
   * Poke settler U10: listing baru berarti ada pekerjaan registrasi
   * contentHash on-chain. Fire-and-forget — pencatatan asinkron, kreator
   * tidak pernah menunggu konfirmasi Base Sepolia; tanpa wiring ini pun
   * settler menemukan barisnya lewat scan berkala (DB adalah antreannya).
   */
  onListingCreated?: () => void;
}

type FieldErrors = Record<string, string>;

function validationError(fields: FieldErrors) {
  return {
    error: "validation_failed",
    message: "One or more listing fields are missing or invalid.",
    fields,
  };
}

export function listingRoutes(deps: ListingRouteDeps) {
  const { catalog, db } = deps;
  const routes = new Hono();

  routes.get("/bounds", (c) => c.json(publishedPriceBounds()));

  routes.post("/prepare", async (c) => {
    let body: unknown;
    try {
      body = ((await c.req.json()) as { body?: unknown }).body;
    } catch {
      return c.json(
        { error: "invalid_json", message: "Send { body: string } as JSON." },
        400,
      );
    }
    if (typeof body !== "string" || body.length === 0) {
      return c.json(validationError({ body: "Prompt body is required." }), 400);
    }
    const contentHash = computeContentHash(body);
    const duplicate = findDuplicate(deps, contentHash);
    if (duplicate) {
      return c.json(duplicateError(duplicate), 409);
    }
    return c.json({ contentHash, teaser: deriveTeaser(body) });
  });

  routes.post("/", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(
        { error: "invalid_form", message: "Send the listing as multipart/form-data." },
        400,
      );
    }

    // Media boleh berupa upload ATAU URL yang kami salin sendiri. R5 tidak
    // melarang kreator menempelkan link — yang dilarang adalah KATALOG
    // menyimpan alamat pihak ketiga, karena pemiliknya bisa mengganti isinya
    // setelah pembeli membayar untuk melihatnya. URL diunduh di sini, byte-nya
    // jadi milik kami, dan katalog tetap hanya menyimpan /media/... sendiri.
    const media = form.get("media");
    const mediaUrl = typeof media === "string" ? media.trim() : "";

    const rawFields: Record<string, unknown> = {};
    for (const name of [
      "title",
      "category",
      "body",
      "priceAtomic",
      "nonce",
      "creatorAddress",
      "signature",
    ]) {
      const value = form.get(name);
      if (typeof value === "string") rawFields[name] = value;
    }
    const parsed = ListingFieldsSchema.safeParse(rawFields);

    // Error field dikumpulkan dulu (zod + media) supaya satu kali submit yang
    // salah menjawab SEMUA field bermasalah sekaligus, bukan satu per satu.
    const fieldErrors: FieldErrors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "form");
        fieldErrors[field] ??= issue.message;
      }
    }
    const hasUpload = media instanceof File && media.size > 0;
    if (!hasUpload && mediaUrl === "") {
      fieldErrors.media ??= "Upload a preview file or paste a link to one.";
    } else if (hasUpload && (media as File).size > MAX_MEDIA_BYTES) {
      fieldErrors.media ??= `Preview media must be at most ${MAX_MEDIA_BYTES} bytes.`;
    }
    if (Object.keys(fieldErrors).length > 0) {
      return c.json(validationError(fieldErrors), 400);
    }
    const fields = parsed.data as ListingFields;

    // Batas harga terpublikasi ditegakkan di sini; jawabannya MEMUAT batas
    // itu sendiri supaya klien non-browser tahu rentangnya tanpa menebak.
    if (!priceWithinBounds(fields.priceAtomic)) {
      return c.json(
        {
          error: "price_out_of_bounds",
          message: "The price is outside the published bounds.",
          ...publishedPriceBounds(),
        },
        400,
      );
    }

    // A link is downloaded before anything else touches storage, and the
    // bytes it produced are validated by exactly the same magic-byte check an
    // upload gets — a remote server's Content-Type is a claim, not evidence.
    let mediaBytes: Uint8Array;
    let declaredType: string;
    if (hasUpload) {
      const mediaFile = media as File;
      mediaBytes = new Uint8Array(await mediaFile.arrayBuffer());
      declaredType = mediaFile.type;
    } else {
      try {
        const fetched = await fetchRemoteMedia(mediaUrl, { maxBytes: MAX_MEDIA_BYTES });
        mediaBytes = fetched.bytes;
        declaredType = fetched.contentType.split(";")[0]!.trim();
      } catch (error) {
        if (error instanceof MediaFetchError) {
          // The creator's own message: they can fix a bad link, and a generic
          // "invalid media" would not tell them which part to fix.
          return c.json(
            { error: "media_fetch_failed", message: error.message, reason: error.code },
            400,
          );
        }
        throw error;
      }
    }
    const classified = classifyMediaUpload(mediaBytes, declaredType);
    if (!classified) {
      return c.json(
        validationError({
          media:
            `Preview media must be one of ${ACCEPTED_MEDIA_TYPES.join(", ")} ` +
            "and its content must match the declared type.",
        }),
        400,
      );
    }

    // Hash dihitung ulang dari body yang DITERIMA (aturan terpublikasi,
    // docs/CONTENT-HASH.md) — nilai hash kiriman klien tidak pernah dipercaya.
    const contentHash = computeContentHash(fields.body);
    const duplicate = findDuplicate(deps, contentHash);
    if (duplicate) {
      return c.json(duplicateError(duplicate), 409);
    }

    // R26/AE10: pesan kanonik dibangun ulang dari field yang diterima plus
    // hash hasil hitung ulang; alamat yang pulih harus sama dengan yang
    // diklaim. Ini SATU-SATUNYA autentikasi — wallet adalah identitasnya.
    const recovered = await recoverListingSigner(
      {
        title: fields.title,
        category: fields.category,
        contentHash,
        priceAtomic: fields.priceAtomic,
        nonce: fields.nonce,
      },
      fields.signature,
    );
    if (!recovered || recovered.toLowerCase() !== fields.creatorAddress.toLowerCase()) {
      return c.json(
        {
          error: "signature_mismatch",
          message:
            "The signature does not recover to the claimed creator address. " +
            "Sign the canonical listing message with the creator wallet and resubmit.",
        },
        401,
      );
    }

    const seedIds = new Set(listPublicEntries(catalog).map((entry) => entry.id));
    const id = deriveListingId(
      fields.title,
      (candidate) => seedIds.has(candidate) || getListing(db, candidate) !== null,
    );

    // Langkah mirror sebelum listing terlihat: gagal tulis = error yang bisa
    // diulang dan TIDAK ada baris listing — katalog tidak pernah menunjuk
    // media yang tidak ada di storage Promit, apalagi URL pihak ketiga.
    let mirrored;
    try {
      mirrored = await mirrorListingUpload(id, classified, mediaBytes, deps.mediaDir);
    } catch (error) {
      console.error(`[listings] media mirror failed for "${id}":`, error);
      return c.json(
        {
          error: "media_mirror_failed",
          message:
            "The preview media could not be stored. Nothing was listed; retry the submission.",
        },
        502,
      );
    }

    // Body ke paid_bodies (KTD17) dan baris listing dalam SATU transaksi:
    // listing yang terlihat di katalog tanpa body yang bisa di-unlock (atau
    // sebaliknya) tidak boleh punya jendela eksistensi sama sekali.
    try {
      db.transaction(() => {
        insertListing(db, {
          id,
          title: fields.title,
          category: fields.category,
          teaser: deriveTeaser(fields.body),
          media: mirrored.media,
          mediaType: mirrored.mediaType,
          mediaStatus: mirrored.mediaStatus,
          poster: mirrored.poster,
          priceAtomic: fields.priceAtomic,
          tier: "paid",
          contentHash,
          creatorAddress: fields.creatorAddress,
          signature: fields.signature,
        });
        setPaidBody(db, id, fields.body);
      })();
    } catch (error) {
      // Balapan dua submit identik: UNIQUE(content_hash) memenangkan yang
      // pertama; yang kedua mendapat 409 yang sama dengan jalur cek dini.
      const racedDuplicate = findDuplicate(deps, contentHash);
      if (racedDuplicate) {
        return c.json(duplicateError(racedDuplicate), 409);
      }
      console.error(`[listings] insert failed for "${id}":`, error);
      return c.json(
        {
          error: "listing_write_failed",
          message: "The listing could not be stored. Nothing was listed; retry the submission.",
        },
        500,
      );
    }

    // Baris listing sudah commit — settler boleh mulai mendaftarkannya
    // on-chain. try/catch karena kegagalan poke tidak boleh menggagalkan
    // respons 201: barisnya tetap tertangkap scan berikutnya.
    try {
      deps.onListingCreated?.();
    } catch (error) {
      console.error(`[listings] settler notify failed for "${id}":`, error);
    }

    return c.json(listingToPublicEntry(getListing(db, id)!), 201);
  });

  return routes;
}

function findDuplicate(
  { catalog, db }: ListingRouteDeps,
  contentHash: string,
): { id: string } | null {
  // Union seed+listing: menerbitkan ulang prompt seed (gratis sekalipun)
  // sebagai listing berbayar adalah duplikat, bukan karya baru.
  const seed = listPublicEntries(catalog).find(
    (entry) => entry.contentHash === contentHash,
  );
  if (seed) return { id: seed.id };
  const listing = findListingByContentHash(db, contentHash);
  return listing ? { id: listing.id } : null;
}

function duplicateError(duplicate: { id: string }) {
  return {
    error: "duplicate_content",
    message:
      `A prompt with this exact body is already listed as "${duplicate.id}" ` +
      "(identical content hash under the published rule).",
    existingId: duplicate.id,
  };
}
