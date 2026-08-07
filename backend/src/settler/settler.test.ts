import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { parseEther } from "viem";
import type { Hex } from "viem";
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
import { canonicalListingMessage, computeContentHash } from "../catalog/listing.ts";
import { deriveTeaser } from "../catalog/normalize.ts";
import {
  getListing,
  getUnlock,
  insertListing,
  markUnlockDelivered,
  openDb,
  recordUnlock as dbRecordUnlock,
  setPaidBody,
} from "../db.ts";
import { listingRoutes } from "../routes/listings.ts";
import { unlockRoutes } from "../routes/unlock.ts";
import {
  DEFAULT_ADMIN_ROLE,
  SETTLER_ROLE,
  UPGRADER_ROLE,
  contentHashToBytes32,
  type RegisteredListing,
  type RegistryChain,
} from "./chain.ts";
import {
  SettlerOverprivilegedError,
  SettlerRoleMissingError,
  SettlerUnderfundedError,
  createSettler,
  type SettlerDeps,
} from "./index.ts";
import {
  enqueueScan,
  ensureSettlerTables,
  getJob,
  getOnchainListing,
  listJobs,
  unlockRef,
} from "./queue.ts";

/**
 * Delapan skenario U10. Semua keputusan settler (idempotensi lewat kunci
 * tersimpan, konfirmasi receipt, backoff, preflight) diuji terhadap
 * FakeChain yang MENGHITUNG transaksi terkirim — bukti idempotensi adalah
 * jumlah kiriman nol pada retry, bukan sekadar jumlah baris.
 */

const catalog = loadCatalogFile();

const SETTLER_ADDR = "0x5e77000000000000000000000000000000005e77";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x9f09CeC811D1fBa47568Ea1397e4C1D0BD8B065F";
const NONCE = (`0x${"77".repeat(32)}`) as Hex;
const FAC_TX = "0x7b62a3ae1bd835907f3f4b9541cf9b4b082c687c5267795178ad2e2c5aad6a85";
const NETWORK = "eip155:84532";
const LISTING_ID = "neon-signup";
const LISTING_BODY =
  "Design a neon-lit signup flow for a night-market app. " +
  "Use bold gradients, oversized numerals, and a three-step progress rail.";

// Kunci uji anvil yang terkenal — tidak pernah menyentuh jaringan nyata.
const creator = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

/**
 * Chain palsu yang meniru kontrak PromitRegistry persis pada perilaku yang
 * penting: recordUnlock men-no-op duplikat DIAM-DIAM (tapi transaksinya
 * tetap terkirim dan tetap dihitung — itulah gas yang dibakar retry naif),
 * dan registerListing TIDAK punya guard duplikat sama sekali.
 */
class FakeChain implements RegistryChain {
  settlerAddress = SETTLER_ADDR;
  balance = parseEther("0.002");
  networkDown = false;
  recordUnlockFailures = 0;
  registerListingFailures = 0;
  receipts = new Map<string, { status: "success" | "reverted" }>();
  registryListings: {
    listingId: bigint;
    creator: string;
    contentHash: Hex;
    price: bigint;
    txHash: string;
  }[] = [];
  registryUnlocks = new Map<string, { listingId: bigint; amount: bigint }>();
  /** Setiap write yang benar-benar terkirim tercatat di sini. */
  sentTransactions: string[] = [];

  private roles = new Map<string, Set<string>>();
  private nextListingId = 1n;
  private txCounter = 0;

  constructor() {
    this.grantRole(SETTLER_ROLE, SETTLER_ADDR);
  }

  grantRole(role: Hex, address: string): void {
    const holders = this.roles.get(role) ?? new Set<string>();
    holders.add(address.toLowerCase());
    this.roles.set(role, holders);
  }

  revokeRole(role: Hex, address: string): void {
    this.roles.get(role)?.delete(address.toLowerCase());
  }

  private ensureUp(): void {
    if (this.networkDown) throw new Error("RPC unreachable: connection refused");
  }

  private unlockKey(payer: string, nonce: string): string {
    return `${payer.toLowerCase()}|${nonce.toLowerCase()}`;
  }

  private mintTxHash(): string {
    this.txCounter += 1;
    return `0x${this.txCounter.toString(16).padStart(64, "0")}`;
  }

  async getEthBalance(): Promise<bigint> {
    this.ensureUp();
    return this.balance;
  }

  async hasRole(role: Hex, account: string): Promise<boolean> {
    this.ensureUp();
    return this.roles.get(role)?.has(account.toLowerCase()) ?? false;
  }

  async isUnlocked(payer: string, nonce: Hex): Promise<boolean> {
    this.ensureUp();
    return this.registryUnlocks.has(this.unlockKey(payer, nonce));
  }

  async findListingByContentHash(contentHash: Hex): Promise<RegisteredListing | null> {
    this.ensureUp();
    const found = this.registryListings.find((entry) => entry.contentHash === contentHash);
    return found ? { listingId: found.listingId, txHash: found.txHash } : null;
  }

  async getTransactionReceipt(
    txHash: string,
  ): Promise<{ status: "success" | "reverted" } | null> {
    this.ensureUp();
    return this.receipts.get(txHash) ?? null;
  }

  async registerListing(args: {
    creator: string;
    contentHash: Hex;
    price: bigint;
    metadataURI: string;
  }): Promise<RegisteredListing> {
    this.ensureUp();
    if (this.registerListingFailures > 0) {
      this.registerListingFailures -= 1;
      throw new Error("registerListing send failed");
    }
    const txHash = this.mintTxHash();
    this.sentTransactions.push(`registerListing:${args.contentHash}`);
    const listingId = this.nextListingId;
    this.nextListingId += 1n;
    this.registryListings.push({ listingId, txHash, ...args });
    return { listingId, txHash };
  }

  async recordUnlock(args: {
    payer: string;
    nonce: Hex;
    listingId: bigint;
    amount: bigint;
  }): Promise<{ txHash: string }> {
    this.ensureUp();
    if (this.recordUnlockFailures > 0) {
      this.recordUnlockFailures -= 1;
      throw new Error("recordUnlock send failed");
    }
    const txHash = this.mintTxHash();
    this.sentTransactions.push(`recordUnlock:${args.payer.toLowerCase()}:${args.nonce}`);
    const key = this.unlockKey(args.payer, args.nonce);
    // No-op diam-diam pada duplikat, persis seperti kontraknya — record
    // pertama tidak pernah tertimpa, tapi gas transaksinya tetap terbayar.
    if (!this.registryUnlocks.has(key)) {
      this.registryUnlocks.set(key, { listingId: args.listingId, amount: args.amount });
    }
    return { txHash };
  }

  recordUnlockSends(): string[] {
    return this.sentTransactions.filter((tx) => tx.startsWith("recordUnlock:"));
  }
}

let db: Database;
let chain: FakeChain;
let clockMs: number;
const now = () => new Date(clockMs);

beforeEach(() => {
  db = openDb(":memory:");
  // Di produksi createSettler yang membuat tabel; tes yang memanggil helper
  // queue sebelum settler ada butuh tabelnya lebih dulu.
  ensureSettlerTables(db);
  chain = new FakeChain();
  clockMs = Date.parse("2026-08-07T10:00:00.000Z");
});

function makeSettler(overrides: Partial<SettlerDeps> = {}) {
  return createSettler({
    db,
    chain,
    now,
    backoffBaseMs: 1_000,
    ...overrides,
  });
}

/** Listing kreator valid, ditanam langsung ke SQLite (jalur U7 penuh diuji terpisah). */
function seedListing(id = LISTING_ID, body = LISTING_BODY): string {
  const contentHash = computeContentHash(body);
  insertListing(db, {
    id,
    title: "Neon Night-Market Signup",
    category: "Landing Page",
    teaser: deriveTeaser(body),
    media: null,
    mediaType: "image",
    mediaStatus: "unavailable",
    poster: null,
    priceAtomic: "250000",
    tier: "paid",
    contentHash,
    creatorAddress: creator.address,
    signature: `0x${"ab".repeat(65)}`,
  });
  setPaidBody(db, id, body);
  return contentHash;
}

/** Unlock yang sudah settle & terkirim ke pembeli, plus receipt facilitator-nya. */
function seedDeliveredUnlock(promptId = LISTING_ID, contentHash?: string): void {
  dbRecordUnlock(db, {
    payer: PAYER,
    paymentNonce: NONCE,
    promptId,
    amountAtomic: "250000",
    contentHash: contentHash ?? computeContentHash(LISTING_BODY),
  });
  markUnlockDelivered(db, PAYER, NONCE, FAC_TX);
  chain.receipts.set(FAC_TX, { status: "success" });
}

// ---------------------------------------------------------------------------
// Skenario 1 — unlock yang settle meng-enqueue TEPAT SATU job pencatatan.
// Jalur settle-nya nyata: tarian 402 U4 lewat seam FacilitatorClient.

class FakeFacilitator implements FacilitatorClient {
  async verify(): Promise<VerifyResponse> {
    return { isValid: true, payer: PAYER };
  }
  async settle(): Promise<SettleResponse> {
    return { success: true, transaction: FAC_TX, network: NETWORK, payer: PAYER };
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
      extensions: [],
      signers: { "eip155:*": ["0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf"] },
    };
  }
}

async function unlockThroughU4(app: Hono, id: string): Promise<Response> {
  const challenge = await app.request(`/v1/prompts/${id}`);
  expect(challenge.status).toBe(402);
  const header = challenge.headers.get("PAYMENT-REQUIRED");
  expect(header).toBeTruthy();
  const accepted = (
    JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as {
      accepts: PaymentRequirements[];
    }
  ).accepts[0]!;
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
        nonce: NONCE,
      },
    },
  };
  return app.request(`/v1/prompts/${id}`, {
    headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

describe("skenario 1: satu unlock settle = tepat satu job pencatatan", () => {
  test("tarian 402 U4 penuh, lalu scan berulang tetap menghasilkan satu job", async () => {
    seedListing();
    const app = new Hono();
    app.route(
      "/v1/prompts",
      unlockRoutes({ catalog, db, payTo: PAY_TO, facilitator: new FakeFacilitator() }),
    );

    const res = await unlockThroughU4(app, LISTING_ID);
    expect(res.status).toBe(200);
    chain.receipts.set(FAC_TX, { status: "success" });

    // Scan tiga kali — PK (kind, ref) membuat enqueue idempoten.
    enqueueScan(db);
    enqueueScan(db);
    enqueueScan(db);
    const recordJobs = listJobs(db).filter((job) => job.kind === "record_unlock");
    expect(recordJobs).toHaveLength(1);
    expect(recordJobs[0]!.ref).toBe(unlockRef(PAYER, NONCE));
    expect(recordJobs[0]!.status).toBe("pending");

    // Drain menuntaskannya: listing terdaftar dulu, lalu unlock tercatat.
    const settler = makeSettler();
    await settler.drain();
    expect(chain.registryUnlocks.size).toBe(1);
    expect(getUnlock(db, PAYER, NONCE)?.onchain_tx_hash).toMatch(/^0x/);
    expect(getJob(db, "record_unlock", unlockRef(PAYER, NONCE))?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Skenario 2 — AE5: replay (payer, nonce) = satu record on-chain, dan retry
// mengirim NOL transaksi. Buktinya jumlah kiriman, bukan jumlah baris.

describe("skenario 2: idempotensi dari kunci tersimpan di registry (AE5)", () => {
  test("retry pasca-crash membaca kunci dan tidak mengirim transaksi", async () => {
    seedListing();
    seedDeliveredUnlock();

    await makeSettler().drain();
    expect(chain.registryUnlocks.size).toBe(1);
    expect(chain.recordUnlockSends()).toHaveLength(1);

    // Replay pembayaran yang sama di level DB: PK (payer, nonce) menolaknya,
    // jadi scan berikutnya tidak menghasilkan job baru.
    expect(
      dbRecordUnlock(db, {
        payer: PAYER.toUpperCase().replace("0X", "0x"), // casing EIP-55 pun tak menembus
        paymentNonce: NONCE,
        promptId: LISTING_ID,
        amountAtomic: "250000",
        contentHash: computeContentHash(LISTING_BODY),
      }),
    ).toBe(false);

    // Simulasi crash SETELAH tx mendarat tapi SEBELUM state lokal tertulis:
    // job kembali pending dan hash on-chain lokal hilang.
    db.query(`UPDATE settler_jobs SET status = 'pending' WHERE kind = 'record_unlock'`).run();
    db.query(`UPDATE unlocks SET onchain_tx_hash = NULL`).run();

    // Settler BARU (restart) men-drain ulang: isUnlocked() = true, jadi
    // job selesai tanpa satu pun transaksi tambahan.
    await makeSettler().drain();
    expect(chain.recordUnlockSends()).toHaveLength(1); // tetap satu — nol kiriman baru
    expect(chain.registryUnlocks.size).toBe(1);
    expect(getJob(db, "record_unlock", unlockRef(PAYER, NONCE))?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Skenario 3 — kegagalan pencatatan di-retry dengan backoff, job tidak hilang.

describe("skenario 3: retry dengan backoff", () => {
  test("gagal dua kali, backoff menggandakan jeda, lalu sukses", async () => {
    seedListing();
    seedDeliveredUnlock();
    chain.recordUnlockFailures = 2;
    const settler = makeSettler();

    await settler.drain();
    const ref = unlockRef(PAYER, NONCE);
    let job = getJob(db, "record_unlock", ref)!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.not_before).toBe(new Date(clockMs + 1_000).toISOString());

    // Belum jatuh tempo: drain tidak menyentuhnya, job tetap ada.
    await settler.drain();
    expect(getJob(db, "record_unlock", ref)!.attempts).toBe(1);

    clockMs += 1_001;
    await settler.drain();
    job = getJob(db, "record_unlock", ref)!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(2);
    expect(job.not_before).toBe(new Date(clockMs + 2_000).toISOString()); // 1000 * 2^1

    clockMs += 2_001;
    await settler.drain();
    expect(getJob(db, "record_unlock", ref)!.status).toBe("done");
    expect(chain.registryUnlocks.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Skenario 4 — hash facilitator tanpa receipt sukses di-flag, tidak ditulis.

describe("skenario 4: hash facilitator dikonfirmasi sebelum registry disentuh", () => {
  test("receipt tidak pernah muncul -> flagged, nol tulisan ke registry", async () => {
    seedListing();
    seedDeliveredUnlock();
    chain.receipts.delete(FAC_TX); // chain tidak pernah melihat hash ini
    const settler = makeSettler({ maxReceiptMisses: 2 });
    const ref = unlockRef(PAYER, NONCE);

    await settler.drain();
    expect(getJob(db, "record_unlock", ref)!.status).toBe("pending"); // miss pertama: masih sabar
    clockMs += 1_001;
    await settler.drain();

    const job = getJob(db, "record_unlock", ref)!;
    expect(job.status).toBe("flagged");
    expect(job.last_error).toContain(FAC_TX);
    expect(chain.recordUnlockSends()).toHaveLength(0);
    expect(chain.registryUnlocks.size).toBe(0);
    // RPC lambat != facilitator bohong: dua pengamatan null yang terpisah
    // dibutuhkan sebelum vonis, dan keduanya tercatat.
    expect(job.receipt_misses).toBe(2);
  });

  test("receipt revert -> flagged seketika tanpa retry", async () => {
    seedListing();
    seedDeliveredUnlock();
    chain.receipts.set(FAC_TX, { status: "reverted" });
    await makeSettler().drain();

    const job = getJob(db, "record_unlock", unlockRef(PAYER, NONCE))!;
    expect(job.status).toBe("flagged");
    expect(job.last_error).toContain("reverted");
    expect(chain.recordUnlockSends()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Skenario 5 — chain mati: unlock tetap terlayani, job tetap pending.

describe("skenario 5: chain tak terjangkau", () => {
  test("drain tidak melempar, baris unlock tetap delivered, job menunggu", async () => {
    seedListing();
    seedDeliveredUnlock();
    chain.networkDown = true;
    const settler = makeSettler();

    await settler.drain(); // tidak melempar — pembeli sudah dilayani, ini urusan belakang
    const ref = unlockRef(PAYER, NONCE);
    expect(getUnlock(db, PAYER, NONCE)!.status).toBe("delivered");
    expect(getJob(db, "record_unlock", ref)!.status).toBe("pending");
    expect(chain.sentTransactions).toHaveLength(0);

    // Chain pulih: job yang sama (bukan job baru) menuntaskan pencatatan.
    chain.networkDown = false;
    clockMs += 60_000;
    await settler.drain();
    expect(getJob(db, "record_unlock", ref)!.status).toBe("done");
    expect(chain.registryUnlocks.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Skenario 6 — saldo ETH di bawah ambang: menolak start dengan error bernama.

describe("skenario 6: preflight saldo", () => {
  test("saldo di bawah ambang -> SettlerUnderfundedError, start() ikut menolak", async () => {
    chain.balance = parseEther("0.0001");
    const settler = makeSettler(); // ambang default 0.0005 ETH

    await expect(settler.preflight()).rejects.toBeInstanceOf(SettlerUnderfundedError);
    await expect(settler.start()).rejects.toMatchObject({ name: "SettlerUnderfundedError" });
    settler.stop();
  });

  test("saldo cukup lolos preflight", async () => {
    await makeSettler().preflight(); // tidak melempar
  });
});

// ---------------------------------------------------------------------------
// Skenario 7 — listing baru mendaftarkan contentHash-nya on-chain,
// lewat route U7 sungguhan yang mem-poke settler.

function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  const ascii = (text: string, at: number) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii("RIFF", 0);
  ascii("WEBP", 8);
  return bytes;
}

async function submitListingForm(body: string): Promise<FormData> {
  const fields = {
    title: "Aurora Checkout Flow",
    category: "Landing Page",
    body,
    priceAtomic: "500000",
    nonce: "nonce-settler-0001",
  };
  const signature = await creator.signMessage({
    message: canonicalListingMessage({
      title: fields.title,
      category: fields.category,
      contentHash: computeContentHash(body),
      priceAtomic: fields.priceAtomic,
      nonce: fields.nonce,
    }),
  });
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  form.set("creatorAddress", creator.address);
  form.set("signature", signature);
  form.set("media", new File([webpBytes() as unknown as Blob], "preview.webp", {
    type: "image/webp",
  }));
  return form;
}

describe("skenario 7: listing baru terdaftar on-chain", () => {
  let mediaDir: string;
  beforeEach(() => {
    mediaDir = mkdtempSync(join(tmpdir(), "promit-settler-media-"));
  });
  afterEach(() => {
    rmSync(mediaDir, { recursive: true, force: true });
  });

  test("submit U7 -> poke -> registry memuat contentHash listing", async () => {
    const settler = makeSettler();
    const drains: Promise<unknown>[] = [];
    const app = new Hono();
    app.route(
      "/v1/listings",
      listingRoutes({
        catalog,
        db,
        mediaDir,
        onListingCreated: () => {
          drains.push(settler.drain());
        },
      }),
    );

    const body = `${LISTING_BODY} Finish with an aurora-gradient receipt screen.`;
    const res = await app.request("/v1/listings", {
      method: "POST",
      body: await submitListingForm(body),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await Promise.all(drains);

    const expectedHash = contentHashToBytes32(computeContentHash(body));
    expect(chain.registryListings).toHaveLength(1);
    expect(chain.registryListings[0]!.contentHash).toBe(expectedHash);
    expect(chain.registryListings[0]!.creator).toBe(creator.address);
    expect(chain.registryListings[0]!.price).toBe(500000n);
    expect(getListing(db, id)!.onchain_tx_hash).toMatch(/^0x/);
    expect(getOnchainListing(db, id)!.listing_id).toBe("1");
  });

  test("chain mati: kreator tetap dapat 201, registrasi menunggu di antrean", async () => {
    chain.networkDown = true;
    const settler = makeSettler();
    const drains: Promise<unknown>[] = [];
    const app = new Hono();
    app.route(
      "/v1/listings",
      listingRoutes({
        catalog,
        db,
        mediaDir,
        onListingCreated: () => {
          drains.push(settler.drain());
        },
      }),
    );

    const res = await app.request("/v1/listings", {
      method: "POST",
      body: await submitListingForm(`${LISTING_BODY} Offline variant.`),
    });
    expect(res.status).toBe(201); // pencatatan asinkron: kreator tidak ikut menunggu chain
    const { id } = (await res.json()) as { id: string };
    await Promise.all(drains);
    expect(getJob(db, "register_listing", id)!.status).toBe("pending");
    expect(getListing(db, id)!.onchain_tx_hash).toBeNull();
  });

  test("crash sebelum state lokal tertulis: log scan mencegah registrasi ganda", async () => {
    seedListing();
    const settler = makeSettler();
    await settler.drain();
    expect(chain.registryListings).toHaveLength(1);

    // Registry sudah memuat listing-nya, tapi state lokal hilang (crash).
    db.query(`DELETE FROM settler_onchain_listings`).run();
    db.query(`UPDATE listings SET onchain_tx_hash = NULL`).run();
    db.query(`UPDATE settler_jobs SET status = 'pending' WHERE kind = 'register_listing'`).run();

    await makeSettler().drain();
    // findListingByContentHash menemukannya — tidak ada registerListing kedua.
    expect(chain.registryListings).toHaveLength(1);
    expect(chain.sentTransactions.filter((t) => t.startsWith("registerListing:"))).toHaveLength(1);
    expect(getOnchainListing(db, LISTING_ID)!.listing_id).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Skenario 8 — kunci settler memegang HANYA settler role.

describe("skenario 8: pemisahan role adalah gerbang start", () => {
  test("tanpa SETTLER_ROLE -> SettlerRoleMissingError", async () => {
    chain.revokeRole(SETTLER_ROLE, SETTLER_ADDR);
    await expect(makeSettler().preflight()).rejects.toBeInstanceOf(SettlerRoleMissingError);
  });

  test("memegang UPGRADER_ROLE -> ditolak: kunci backend tidak boleh bisa upgrade", async () => {
    chain.grantRole(UPGRADER_ROLE, SETTLER_ADDR);
    await expect(makeSettler().preflight()).rejects.toBeInstanceOf(SettlerOverprivilegedError);
    await expect(makeSettler().preflight()).rejects.toMatchObject({
      name: "SettlerOverprivilegedError",
    });
  });

  test("memegang DEFAULT_ADMIN_ROLE -> ditolak dengan error bernama yang sama", async () => {
    chain.grantRole(DEFAULT_ADMIN_ROLE, SETTLER_ADDR);
    await expect(makeSettler().preflight()).rejects.toBeInstanceOf(SettlerOverprivilegedError);
  });

  test("provisioning benar (hanya SETTLER_ROLE) lolos", async () => {
    await makeSettler().preflight();
  });
});

// ---------------------------------------------------------------------------
// Konversi content hash: aturan terpublikasi -> bytes32 registry.

describe("contentHashToBytes32", () => {
  test("merender keccak256:<hex> menjadi bytes32 0x<hex>", () => {
    const hash = computeContentHash(LISTING_BODY);
    expect(contentHashToBytes32(hash)).toBe(`0x${hash.slice("keccak256:".length)}`);
  });

  test("menolak hash yang tidak mengikuti aturan terpublikasi", () => {
    expect(() => contentHashToBytes32("sha256:deadbeef")).toThrow(/published/i);
    expect(() => contentHashToBytes32(`keccak256:${"Z".repeat(64)}`)).toThrow();
  });
});
