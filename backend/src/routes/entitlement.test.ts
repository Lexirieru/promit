import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import { loadCatalogFile } from "../catalog/index.ts";
import { createApp } from "../index.ts";
import {
  insertListing,
  markSettledButUndelivered,
  markUnlockDelivered,
  openDb,
  recordUnlock,
  setPaidBody,
  type NewListing,
} from "../db.ts";
import {
  ENTITLEMENT_PROOF_HEADER,
  canonicalEntitlementMessage,
} from "../entitlement.ts";
import { unlockRoutes } from "./unlock.ts";

/**
 * Endpoint kepemilikan (celah pembeli-yang-kembali). Dua kontrak diuji:
 *
 * - GET /v1/unlocks?payer= mendaftar unlock DELIVERED sebuah wallet —
 *   metadata saja, tidak pernah teks.
 * - GET /v1/prompts/:id dengan bukti entitlement bertanda tangan
 *   mengembalikan teks TANPA menagih lagi; bukti cacat/kedaluwarsa DITOLAK
 *   401 (bukan dijatuhkan diam-diam ke jalur tagih), dan wallet lain —
 *   bukti sah, tanpa baris delivered — tetap ditagih 402.
 *
 * Facilitator dipalsukan di seam yang sama dengan unlock.test.ts; di sini
 * perannya satu-satunya adalah MEMBUKTIKAN dia tidak pernah disentuh pada
 * jalur kepemilikan.
 */

const catalog = loadCatalogFile();

const PAY_TO = "0x1111111111111111111111111111111111111111";
const TX_HASH = `0x${"22".repeat(32)}`;
const PAID_BODY = "SECRET-PAID-PROMPT-BODY for the returning-buyer tests";

/** anvil #0 — kunci publik sekali pakai untuk tanda tangan offline di tes. */
const OWNER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
/** anvil #1 — wallet lain yang TIDAK memiliki prompt. */
const STRANGER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const PAYMENT_NONCE = `0x${"11".repeat(32)}`;

const PAID_LISTING: NewListing = {
  id: "paid-owned-prompt",
  title: "Paid Owned Prompt",
  category: "Hero",
  teaser: "A paid prompt someone already bought.",
  media: null,
  mediaType: "image",
  mediaStatus: "unavailable",
  poster: null,
  priceAtomic: "99000",
  tier: "paid",
  contentHash: `keccak256:${"ab".repeat(32)}`,
  creatorAddress: "0x2222222222222222222222222222222222222222",
  signature: "0xsig",
};

class RefusingFacilitator implements FacilitatorClient {
  verifyCalls: unknown[] = [];
  settleCalls: unknown[] = [];
  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls.push([p, r]);
    throw new Error("the ownership path must never verify a payment");
  }
  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls.push([p, r]);
    throw new Error("the ownership path must never settle a payment");
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: { "eip155:*": ["0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf"] },
    };
  }
}

let db: Database;
let facilitator: RefusingFacilitator;

function makeApp() {
  const app = new Hono();
  app.route("/v1/prompts", unlockRoutes({ catalog, db, payTo: PAY_TO, facilitator }));
  return app;
}

function seedDeliveredUnlock(payer: string, promptId = PAID_LISTING.id) {
  recordUnlock(db, {
    payer,
    paymentNonce: PAYMENT_NONCE,
    promptId,
    amountAtomic: PAID_LISTING.priceAtomic,
    contentHash: PAID_LISTING.contentHash,
  });
  markUnlockDelivered(db, payer, PAYMENT_NONCE, TX_HASH);
}

async function signedProof(
  account: typeof OWNER,
  promptId: string,
  overrides: { issuedAt?: string; payer?: string; nonce?: string } = {},
): Promise<string> {
  const nonce = overrides.nonce ?? "test-nonce-1234";
  const issuedAt = overrides.issuedAt ?? Date.now().toString();
  const signature = await account.signMessage({
    message: canonicalEntitlementMessage({ promptId, nonce, issuedAt }),
  });
  return [overrides.payer ?? account.address, nonce, issuedAt, signature].join("|");
}

beforeEach(() => {
  db = openDb(":memory:");
  facilitator = new RefusingFacilitator();
  insertListing(db, PAID_LISTING);
  setPaidBody(db, PAID_LISTING.id, PAID_BODY);
});

describe("GET /v1/unlocks — daftar kepemilikan sebuah wallet", () => {
  test("tanpa payer atau payer cacat menjawab 400", async () => {
    const app = createApp({ catalog, db });
    expect((await app.request("/v1/unlocks")).status).toBe(400);
    expect((await app.request("/v1/unlocks?payer=not-an-address")).status).toBe(400);
  });

  test("hanya baris delivered yang terdaftar; pending dan settled_but_undelivered tidak", async () => {
    seedDeliveredUnlock(OWNER.address);
    // Baris pending (nonce lain) dan settled_but_undelivered (nonce ketiga).
    recordUnlock(db, {
      payer: OWNER.address,
      paymentNonce: `0x${"33".repeat(32)}`,
      promptId: "some-pending-prompt",
      amountAtomic: "1",
      contentHash: `keccak256:${"cd".repeat(32)}`,
    });
    recordUnlock(db, {
      payer: OWNER.address,
      paymentNonce: `0x${"44".repeat(32)}`,
      promptId: "some-undelivered-prompt",
      amountAtomic: "1",
      contentHash: `keccak256:${"ef".repeat(32)}`,
    });
    markSettledButUndelivered(db, OWNER.address, `0x${"44".repeat(32)}`, `0x${"55".repeat(32)}`);

    const app = createApp({ catalog, db });
    const res = await app.request(`/v1/unlocks?payer=${OWNER.address}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payer: string;
      unlocks: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.payer).toBe(OWNER.address.toLowerCase());
    expect(body.total).toBe(1);
    expect(body.unlocks).toEqual([
      {
        id: PAID_LISTING.id,
        unlockedAt: expect.any(String),
        txHash: TX_HASH,
        contentHash: PAID_LISTING.contentHash,
      },
    ]);
    // Metadata saja — teks tidak pernah lewat daftar ini.
    expect(JSON.stringify(body)).not.toContain(PAID_BODY.slice(0, 20));
  });

  test("payer EIP-55 dan lowercase menunjuk wallet yang sama", async () => {
    seedDeliveredUnlock(OWNER.address.toLowerCase());
    const app = createApp({ catalog, db });
    const res = await app.request(`/v1/unlocks?payer=${OWNER.address}`);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  test("wallet tanpa unlock menjawab daftar kosong, bukan error", async () => {
    const app = createApp({ catalog, db });
    const res = await app.request(`/v1/unlocks?payer=${STRANGER.address}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(0);
  });
});

describe("GET /v1/prompts/:id — pembeli yang kembali", () => {
  test("bukti sah pemilik: teks kembali tanpa 402 dan facilitator tidak pernah disentuh", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: { [ENTITLEMENT_PROOF_HEADER]: await signedProof(OWNER, PAID_LISTING.id) },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.text).toBe(PAID_BODY);
    expect(body.txHash).toBe(TX_HASH);
    expect(body.contentHash).toBe(PAID_LISTING.contentHash);
    expect(body.payer).toBe(OWNER.address.toLowerCase());
    expect(body.alreadyOwned).toBe(true);

    // Tidak ditagih: tidak ada verify, tidak ada settle.
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  test("bukti lewat query string juga berlaku (jalur curl)", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();
    const nonce = "query-nonce-1";
    const issuedAt = Date.now().toString();
    const signature = await OWNER.signMessage({
      message: canonicalEntitlementMessage({ promptId: PAID_LISTING.id, nonce, issuedAt }),
    });
    const query = new URLSearchParams({
      payer: OWNER.address,
      nonce,
      issuedAt,
      signature,
    });
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}?${query}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { alreadyOwned?: boolean }).alreadyOwned).toBe(true);
  });

  test("alamat tanpa tanda tangan DITOLAK 401 — alamat saja bisa diketik siapa pun", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();

    const viaQuery = await app.request(
      `/v1/prompts/${PAID_LISTING.id}?payer=${OWNER.address}`,
    );
    expect(viaQuery.status).toBe(401);
    const viaHeader = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: { [ENTITLEMENT_PROOF_HEADER]: OWNER.address },
    });
    expect(viaHeader.status).toBe(401);

    const queryBody = await viaQuery.text();
    const headerBody = await viaHeader.text();
    expect(queryBody).not.toContain(PAID_BODY.slice(0, 20));
    expect(headerBody).not.toContain(PAID_BODY.slice(0, 20));
    expect((JSON.parse(queryBody) as { error: string }).error).toBe("entitlement_malformed");
  });

  test("tanda tangan orang lain atas payer yang diklaim DITOLAK 401 tanpa teks", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();
    // STRANGER menandatangani tapi mengklaim alamat OWNER.
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: {
        [ENTITLEMENT_PROOF_HEADER]: await signedProof(STRANGER, PAID_LISTING.id, {
          payer: OWNER.address,
        }),
      },
    });
    expect(res.status).toBe(401);
    const raw = await res.text();
    expect(raw).not.toContain(PAID_BODY.slice(0, 20));
    expect((JSON.parse(raw) as { error: string }).error).toBe("entitlement_signature_mismatch");
  });

  test("bukti kedaluwarsa (dan bukti dari masa depan) DITOLAK 401", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();

    const expired = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: {
        [ENTITLEMENT_PROOF_HEADER]: await signedProof(OWNER, PAID_LISTING.id, {
          issuedAt: (Date.now() - 6 * 60_000).toString(),
        }),
      },
    });
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { error: string }).error).toBe("entitlement_expired");

    const future = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: {
        [ENTITLEMENT_PROOF_HEADER]: await signedProof(OWNER, PAID_LISTING.id, {
          issuedAt: (Date.now() + 2 * 60_000).toString(),
        }),
      },
    });
    expect(future.status).toBe(401);
  });

  test("tanda tangan untuk prompt lain tidak membuka prompt ini", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();
    // Pesan menyebut prompt lain; server membangun pesan dari PATH, jadi
    // pemulihan menghasilkan alamat acak yang bukan payer yang diklaim.
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: {
        [ENTITLEMENT_PROOF_HEADER]: await signedProof(OWNER, "some-other-prompt"),
      },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(PAID_BODY.slice(0, 20));
  });

  test("wallet lain — bukti sah, tanpa baris delivered — tetap ditagih 402", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: { [ENTITLEMENT_PROOF_HEADER]: await signedProof(STRANGER, PAID_LISTING.id) },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(await res.text()).not.toContain(PAID_BODY.slice(0, 20));
  });

  test("settled_but_undelivered bukan kepemilikan: jalur baca tidak menyelesaikannya diam-diam", async () => {
    recordUnlock(db, {
      payer: OWNER.address,
      paymentNonce: PAYMENT_NONCE,
      promptId: PAID_LISTING.id,
      amountAtomic: PAID_LISTING.priceAtomic,
      contentHash: PAID_LISTING.contentHash,
    });
    markSettledButUndelivered(db, OWNER.address, PAYMENT_NONCE, TX_HASH);

    const app = makeApp();
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`, {
      headers: { [ENTITLEMENT_PROOF_HEADER]: await signedProof(OWNER, PAID_LISTING.id) },
    });
    expect(res.status).toBe(402);
  });

  test("tanpa bukti sama sekali perilaku lama utuh: 402 dengan PAYMENT-REQUIRED", async () => {
    seedDeliveredUnlock(OWNER.address);
    const app = makeApp();
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`);
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });
});
