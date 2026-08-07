import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { loadCatalogFile } from "../catalog/index.ts";
import {
  MAX_PRICE_ATOMIC,
  MIN_PRICE_ATOMIC,
  canonicalListingMessage,
  computeContentHash,
} from "../catalog/listing.ts";
import { getPaidBody, insertListing, listListings, openDb } from "../db.ts";
import { catalogRoutes } from "./catalog.ts";
import { listingRoutes, type ListingRouteDeps } from "./listings.ts";
import { unlockRoutes } from "./unlock.ts";

/**
 * Skenario tes U7. Tanda tangan dibuat dengan kunci viem SUNGGUHAN
 * (privateKeyToAccount.signMessage = EIP-191 asli), jadi jalur pemulihan
 * server diuji terhadap kriptografi nyata, bukan stub. Unlock lewat U4
 * memakai seam FacilitatorClient yang sama dengan unlock.test.ts.
 */

const catalog = loadCatalogFile();
const CATALOG_JSON_PATH = fileURLToPath(new URL("../../data/catalog.json", import.meta.url));

// Kunci uji anvil/hardhat yang terkenal — tidak pernah dipakai di jaringan nyata.
const creator = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const attacker = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const DEFAULT_BODY =
  "Design a neon-lit signup flow for a night-market app. " +
  "Use bold gradients, oversized numerals, and a three-step progress rail. " +
  "Close with a confirmation screen that echoes the stall's neon signage.";

const NETWORK = "eip155:84532";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x9f09CeC811D1fBa47568Ea1397e4C1D0BD8B065F";
const TX_HASH = "0x7b62a3ae1bd835907f3f4b9541cf9b4b082c687c5267795178ad2e2c5aad6a85";

class FakeFacilitator implements FacilitatorClient {
  async verify(): Promise<VerifyResponse> {
    return { isValid: true, payer: PAYER };
  }
  async settle(): Promise<SettleResponse> {
    return { success: true, transaction: TX_HASH, network: NETWORK, payer: PAYER };
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
      extensions: [],
      signers: { "eip155:*": ["0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf"] },
    };
  }
}

let db: Database;
let mediaDir: string;

beforeEach(() => {
  db = openDb(":memory:");
  mediaDir = mkdtempSync(join(tmpdir(), "promit-listing-media-"));
});

afterEach(() => {
  rmSync(mediaDir, { recursive: true, force: true });
});

function makeApp(overrides: Partial<ListingRouteDeps> = {}) {
  const app = new Hono();
  app.route("/v1/listings", listingRoutes({ catalog, db, mediaDir, ...overrides }));
  app.route("/v1/catalog", catalogRoutes({ catalog, db }));
  app.route(
    "/v1/prompts",
    unlockRoutes({ catalog, db, payTo: PAY_TO, facilitator: new FakeFacilitator() }),
  );
  return app;
}

function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  const ascii = (text: string, at: number) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii("RIFF", 0);
  ascii("WEBP", 8);
  return bytes;
}

const defaultMedia = () =>
  new File([webpBytes() as unknown as Blob], "preview.webp", { type: "image/webp" });

interface SubmissionFields {
  title: string;
  category: string;
  body: string;
  priceAtomic: string;
  nonce: string;
  creatorAddress: string;
  signature: string;
}

/** Kiriman valid default: field + tanda tangan EIP-191 asli dari `creator`. */
async function signedSubmission(
  overrides: Partial<SubmissionFields> = {},
  options: { signer?: typeof creator; signedPriceAtomic?: string } = {},
): Promise<SubmissionFields> {
  const signer = options.signer ?? creator;
  const title = overrides.title ?? "Neon Night-Market Signup";
  const category = overrides.category ?? "Landing Page";
  const body = overrides.body ?? DEFAULT_BODY;
  const priceAtomic = overrides.priceAtomic ?? "250000";
  const nonce = overrides.nonce ?? "nonce-0000000001";
  const signature =
    overrides.signature ??
    (await signer.signMessage({
      message: canonicalListingMessage({
        title,
        category,
        contentHash: computeContentHash(body),
        priceAtomic: options.signedPriceAtomic ?? priceAtomic,
        nonce,
      }),
    }));
  return {
    title,
    category,
    body,
    priceAtomic,
    nonce,
    creatorAddress: overrides.creatorAddress ?? creator.address,
    signature,
  };
}

function formFrom(
  fields: Partial<SubmissionFields>,
  media: File | string | null = defaultMedia(),
): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(name, value);
  }
  if (media !== null) form.set("media", media as Blob);
  return form;
}

const postListing = (app: Hono, form: FormData) =>
  app.request("/v1/listings", { method: "POST", body: form });

function uploadedFiles(): string[] {
  const uploads = join(mediaDir, "uploads");
  return existsSync(uploads) ? readdirSync(uploads) : [];
}

function decodePaymentRequired(res: Response): { accepts: PaymentRequirements[] } {
  const header = res.headers.get("PAYMENT-REQUIRED");
  expect(header).toBeTruthy();
  return JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
}

/** Sisi klien tarian 402 U4: tantangan, lalu ulang dengan PAYMENT-SIGNATURE. */
async function unlockThroughU4(app: Hono, id: string): Promise<Response> {
  const challenge = await app.request(`/v1/prompts/${id}`);
  expect(challenge.status).toBe(402);
  const accepted = decodePaymentRequired(challenge).accepts[0]!;
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"77".repeat(32)}`,
      },
    },
  };
  return app.request(`/v1/prompts/${id}`, {
    headers: {
      "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
  });
}

describe("GET /v1/listings/bounds", () => {
  test("batas harga dipublikasikan sebagai atomic string dan membentuk rentang", async () => {
    const app = makeApp();
    const res = await app.request("/v1/listings/bounds");
    expect(res.status).toBe(200);
    const bounds = (await res.json()) as { minPriceAtomic: string; maxPriceAtomic: string };
    expect(bounds.minPriceAtomic).toBe(MIN_PRICE_ATOMIC.toString());
    expect(bounds.maxPriceAtomic).toBe(MAX_PRICE_ATOMIC.toString());
    expect(BigInt(bounds.minPriceAtomic)).toBeGreaterThan(0n);
    expect(BigInt(bounds.maxPriceAtomic)).toBeGreaterThan(BigInt(bounds.minPriceAtomic));
  });
});

describe("POST /v1/listings/prepare", () => {
  test("menjawab contentHash menurut aturan terpublikasi plus teaser", async () => {
    const app = makeApp();
    const res = await app.request("/v1/listings/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: DEFAULT_BODY }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { contentHash: string; teaser: string };
    expect(data.contentHash).toBe(computeContentHash(DEFAULT_BODY));
    expect(data.teaser.length).toBeGreaterThan(0);
    expect(data.teaser.length).toBeLessThan(DEFAULT_BODY.length);
  });

  test("body identik dengan entri seed terdeteksi duplikat SEBELUM tanda tangan", async () => {
    const app = makeApp();
    const seed = catalog.entries.find((entry) => entry.body !== undefined)!;
    const res = await app.request("/v1/listings/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: seed.body }),
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string; existingId: string };
    expect(data.error).toBe("duplicate_content");
    expect(data.existingId).toBe(seed.id);
  });

  test("body kosong ditolak dengan error field", async () => {
    const app = makeApp();
    const res = await app.request("/v1/listings/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(data.error).toBe("validation_failed");
    expect(data.fields.body).toBeTruthy();
  });
});

describe("POST /v1/listings — validasi field", () => {
  test("field wajib yang hilang ditolak dengan error per-field, semuanya sekaligus", async () => {
    const app = makeApp();
    const res = await postListing(app, formFrom({}, null));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(data.error).toBe("validation_failed");
    for (const field of [
      "title",
      "category",
      "body",
      "priceAtomic",
      "nonce",
      "creatorAddress",
      "signature",
      "media",
    ]) {
      expect(data.fields[field]).toBeTruthy();
    }
  });

  test("kategori di luar enum menjadi error field, bukan crash", async () => {
    const app = makeApp();
    const fields = await signedSubmission({ category: "Memes" });
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { fields: Record<string, string> };
    expect(data.fields.category).toBeTruthy();
  });

  test("harga di bawah batas bawah ditolak dan jawabannya memuat batas terpublikasi", async () => {
    const app = makeApp();
    const below = (MIN_PRICE_ATOMIC - 1n).toString();
    const fields = await signedSubmission({ priceAtomic: below });
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, string>;
    expect(data.error).toBe("price_out_of_bounds");
    expect(data.minPriceAtomic).toBe(MIN_PRICE_ATOMIC.toString());
    expect(data.maxPriceAtomic).toBe(MAX_PRICE_ATOMIC.toString());
    expect(listListings(db)).toHaveLength(0);
  });

  test("harga di atas batas atas ditolak", async () => {
    const app = makeApp();
    const above = (MAX_PRICE_ATOMIC + 1n).toString();
    const fields = await signedSubmission({ priceAtomic: above });
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("price_out_of_bounds");
  });
});

describe("POST /v1/listings — media wajib upload (R5)", () => {
  test("string URL di field media ditolak dengan namanya sendiri", async () => {
    const app = makeApp();
    const fields = await signedSubmission();
    const res = await postListing(app, formFrom(fields, "https://evil.example/beacon.gif"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("media_must_be_upload");
    expect(listListings(db)).toHaveLength(0);
    expect(uploadedFiles()).toHaveLength(0);
  });

  test("byte HTML berlabel image/webp ditolak — magic bytes wajib cocok", async () => {
    const app = makeApp();
    const fields = await signedSubmission();
    const html = new File(["<html><script>alert(1)</script></html>"], "x.webp", {
      type: "image/webp",
    });
    const res = await postListing(app, formFrom(fields, html));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { fields: Record<string, string> };
    expect(data.fields.media).toBeTruthy();
    expect(uploadedFiles()).toHaveLength(0);
  });

  test("gagal mirror = error yang bisa diulang dan listing TIDAK pernah muncul", async () => {
    // mediaDir menunjuk sebuah FILE sehingga mkdir uploads/ gagal (ENOTDIR).
    const notADir = join(mediaDir, "not-a-dir");
    writeFileSync(notADir, "occupied");
    const app = makeApp({ mediaDir: notADir });
    const fields = await signedSubmission();
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("media_mirror_failed");

    expect(listListings(db)).toHaveLength(0);
    const list = await app.request("/v1/catalog");
    const { entries } = (await list.json()) as { entries: Array<{ title: string }> };
    expect(entries.some((entry) => entry.title === fields.title)).toBe(false);
  });

  test("mekanis: baris listing ber-URL pihak ketiga ditolak skema sebelum masuk tabel", () => {
    expect(() =>
      insertListing(db, {
        id: "sneaky-listing",
        title: "Sneaky",
        category: "Hero",
        teaser: "Sneaky teaser.",
        media: "https://evil.example/beacon.gif",
        mediaType: "image",
        mediaStatus: "mirrored",
        poster: null,
        priceAtomic: "250000",
        tier: "paid",
        contentHash: `keccak256:${"ef".repeat(32)}`,
        creatorAddress: creator.address,
        signature: `0x${"ab".repeat(65)}`,
      }),
    ).toThrow();
    expect(listListings(db)).toHaveLength(0);
  });
});

describe("POST /v1/listings — tanda tangan (AE10/R26)", () => {
  test("tanda tangan kunci lain yang mengklaim alamat kreator ditolak 401", async () => {
    const app = makeApp();
    const fields = await signedSubmission({}, { signer: attacker });
    expect(fields.creatorAddress).toBe(creator.address);
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("signature_mismatch");
    expect(listListings(db)).toHaveLength(0);
    expect(uploadedFiles()).toHaveLength(0);
  });

  test("harga yang diubah setelah ditandatangani mematahkan pemulihan (payload terikat)", async () => {
    const app = makeApp();
    const fields = await signedSubmission(
      { priceAtomic: "9900000" },
      { signedPriceAtomic: "250000" },
    );
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_mismatch");
  });

  test("tanda tangan yang tidak bisa dipulihkan sama sekali ditolak 401, bukan crash", async () => {
    const app = makeApp();
    const fields = await signedSubmission({ signature: `0x${"ab".repeat(65)}` });
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_mismatch");
  });
});

describe("POST /v1/listings — kiriman valid", () => {
  test("kiriman bertanda tangan sah membuat listing berbayar yang muncul di katalog dan bisa di-unlock lewat U4", async () => {
    const app = makeApp();
    const fields = await signedSubmission();
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(201);
    const entry = (await res.json()) as Record<string, unknown> & {
      id: string;
      contentHash: string;
      attribution: { source: string; note: string };
    };

    expect(entry.id).toBe("neon-night-market-signup");
    expect(entry.tier).toBe("paid");
    expect(entry.priceAtomic).toBe(fields.priceAtomic);
    expect(entry.media).toBe(`/media/uploads/${entry.id}.webp`);
    expect(entry.mediaStatus).toBe("mirrored");
    expect(entry.contentHash).toBe(computeContentHash(fields.body));
    // R24: katalognya sendiri yang menyatakan preview = output prompt ini.
    expect(entry.attribution.note).toContain("Preview generated by running this prompt");
    expect(entry.attribution.source).toContain(creator.address);
    // Tidak ada field body di respons mana pun (kontrak API terkunci).
    expect("body" in entry).toBe(false);

    // Byte upload mendarat di storage milik Promit dengan nama deterministik.
    expect(uploadedFiles()).toEqual([`${entry.id}.webp`]);

    // Muncul di union katalog publik.
    const detail = await app.request(`/v1/catalog/${entry.id}`);
    expect(detail.status).toBe(200);
    const list = await app.request("/v1/catalog?tier=paid");
    const { entries } = (await list.json()) as { entries: Array<{ id: string }> };
    expect(entries.some((row) => row.id === entry.id)).toBe(true);

    // Bisa di-unlock lewat U4: teks kembali setelah settle, hash konsisten.
    const unlocked = await unlockThroughU4(app, entry.id);
    expect(unlocked.status).toBe(200);
    const paid = (await unlocked.json()) as Record<string, string>;
    expect(paid.text).toBe(fields.body);
    expect(paid.contentHash).toBe(entry.contentHash);
    expect(paid.txHash).toBe(TX_HASH);
  });

  test("hash tersimpan = hash yang dihitung ulang atas teks tersimpan menurut aturan terpublikasi", async () => {
    const app = makeApp();
    const fields = await signedSubmission();
    const res = await postListing(app, formFrom(fields));
    const entry = (await res.json()) as { id: string; contentHash: string };

    const storedBody = getPaidBody(db, entry.id);
    expect(storedBody).toBe(fields.body);
    expect(computeContentHash(storedBody!)).toBe(entry.contentHash);
    const row = listListings(db)[0]!;
    expect(row.content_hash).toBe(entry.contentHash);
  });

  test("tidak ada body listing yang tertulis ke backend/data/catalog.json", async () => {
    const before = readFileSync(CATALOG_JSON_PATH, "utf8");
    const app = makeApp();
    const fields = await signedSubmission();
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(201);

    const after = readFileSync(CATALOG_JSON_PATH, "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain(fields.body.slice(0, 40));
  });

  test("judul yang menabrak id seed mendapat sufiks — seed menang di union, jadi id itu tak boleh diterbitkan", async () => {
    const app = makeApp();
    const seedTitle = catalog.entries[0]!.title;
    const fields = await signedSubmission({ title: seedTitle, body: `${DEFAULT_BODY} v2` });
    const res = await postListing(app, formFrom(fields));
    expect(res.status).toBe(201);
    const entry = (await res.json()) as { id: string };
    expect(entry.id).toBe(`${catalog.entries[0]!.id}-2`);
  });

  test("body identik dengan listing yang ada terdeteksi duplikat lewat content hash", async () => {
    const app = makeApp();
    const first = await signedSubmission();
    expect((await postListing(app, formFrom(first))).status).toBe(201);

    const second = await signedSubmission({
      title: "Different Title Same Body",
      nonce: "nonce-0000000002",
    });
    const res = await postListing(app, formFrom(second));
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string; existingId: string };
    expect(data.error).toBe("duplicate_content");
    expect(data.existingId).toBe("neon-night-market-signup");
    expect(listListings(db)).toHaveLength(1);
  });
});
