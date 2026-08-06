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
import { VerifyError } from "@x402/core/types";
import { loadCatalogFile } from "../catalog/index.ts";
import { createApp } from "../index.ts";
import {
  getUnlock,
  insertListing,
  openDb,
  setPaidBody,
  type NewListing,
} from "../db.ts";
import { unlockRoutes, type UnlockRouteDeps } from "./unlock.ts";

/**
 * Plan U4 test scenarios, written against the facilitator contract observed
 * in docs/ARCHITECTURE.md §12. The facilitator is faked at the
 * FacilitatorClient seam — the same interface HTTPFacilitatorClient
 * implements — so every wire shape above that seam (PAYMENT-REQUIRED /
 * PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers, accepts matching) is the
 * real library code path.
 */

const catalog = loadCatalogFile();

const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x9f09CeC811D1fBa47568Ea1397e4C1D0BD8B065F";
const TX_HASH = "0x7b62a3ae1bd835907f3f4b9541cf9b4b082c687c5267795178ad2e2c5aad6a85";

// Sentinel body text that must never appear in any unpaid or failed response.
const PAID_BODY = "SECRET-PAID-PROMPT-BODY: build a cinematic hero section with";

const PAID_LISTING: NewListing = {
  id: "paid-cinematic-hero",
  title: "Paid Cinematic Hero",
  category: "Hero",
  teaser: "A paid prompt for a cinematic hero.",
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

const OTHER_PAID_LISTING: NewListing = {
  ...PAID_LISTING,
  id: "paid-pricier-prompt",
  title: "Paid Pricier Prompt",
  teaser: "A second paid prompt at a different price.",
  priceAtomic: "250000",
  contentHash: `keccak256:${"cd".repeat(32)}`,
};

class FakeFacilitator implements FacilitatorClient {
  verifyCalls: Array<{ paymentPayload: PaymentPayload; requirements: PaymentRequirements }> = [];
  settleCalls: Array<{ paymentPayload: PaymentPayload; requirements: PaymentRequirements }> = [];

  verifyImpl: () => Promise<VerifyResponse> = async () => ({ isValid: true, payer: PAYER });
  settleImpl: () => Promise<SettleResponse> = async () => ({
    success: true,
    transaction: TX_HASH,
    network: NETWORK,
    payer: PAYER,
  });

  async verify(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.verifyCalls.push({ paymentPayload, requirements });
    return this.verifyImpl();
  }

  async settle(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls.push({ paymentPayload, requirements });
    return this.settleImpl();
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
let facilitator: FakeFacilitator;

function makeApp(overrides: Partial<UnlockRouteDeps> = {}) {
  const app = new Hono();
  app.route(
    "/v1/prompts",
    unlockRoutes({ catalog, db, payTo: PAY_TO, facilitator, ...overrides }),
  );
  return app;
}

function decodePaymentRequired(res: Response): {
  x402Version: number;
  accepts: PaymentRequirements[];
} {
  const header = res.headers.get("PAYMENT-REQUIRED");
  expect(header).toBeTruthy();
  return JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
}

/** Builds the PAYMENT-SIGNATURE header a v2 client would send back. */
function paymentHeaderFor(accepted: PaymentRequirements, nonceByte = "77"): string {
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
        nonce: `0x${nonceByte.repeat(32)}`,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Runs the client side of the 402 dance: challenge, then paid retry. */
async function paidRequest(
  app: Hono,
  id: string,
  nonceByte = "77",
): Promise<{ res: Response; accepted: PaymentRequirements }> {
  const challenge = await app.request(`/v1/prompts/${id}`);
  expect(challenge.status).toBe(402);
  const accepted = decodePaymentRequired(challenge).accepts[0]!;
  const res = await app.request(`/v1/prompts/${id}`, {
    headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(accepted, nonceByte) },
  });
  return { res, accepted };
}

beforeEach(() => {
  db = openDb(":memory:");
  facilitator = new FakeFacilitator();
  insertListing(db, PAID_LISTING);
  insertListing(db, OTHER_PAID_LISTING);
  setPaidBody(db, PAID_LISTING.id, PAID_BODY);
  setPaidBody(db, OTHER_PAID_LISTING.id, "other paid body text");
});

describe("GET /v1/prompts/:id — 402 challenge (AE1)", () => {
  test("a paid prompt with no payment header returns 402 with no prompt text", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`);
    expect(res.status).toBe(402);

    const raw = await res.text();
    expect(raw).not.toContain(PAID_BODY.slice(0, 30));
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.error).toBe("payment_required");
    expect(body.priceAtomic).toBe(PAID_LISTING.priceAtomic);

    // The challenge alone must not touch the facilitator's paid endpoints.
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  test("the 402 payload names USDC, eip155:84532, and the prompt's atomic price", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/prompts/${PAID_LISTING.id}`);
    const required = decodePaymentRequired(res);

    expect(required.x402Version).toBe(2);
    const accepts = required.accepts[0]!;
    expect(accepts.scheme).toBe("exact");
    expect(accepts.network).toBe(NETWORK);
    expect(accepts.asset.toLowerCase()).toBe(USDC.toLowerCase());
    expect(accepts.amount).toBe(PAID_LISTING.priceAtomic);
    expect(accepts.payTo).toBe(PAY_TO);
    // KTD18: the EIP-712 domain rides in extra, never hardcoded client-side.
    expect(accepts.extra).toMatchObject({ name: "USDC", version: "2" });
  });

  test("two prompts at different prices produce two different amounts from the same route", async () => {
    const app = makeApp();
    const cheap = decodePaymentRequired(await app.request(`/v1/prompts/${PAID_LISTING.id}`));
    const pricey = decodePaymentRequired(
      await app.request(`/v1/prompts/${OTHER_PAID_LISTING.id}`),
    );
    expect(cheap.accepts[0]!.amount).toBe("99000");
    expect(pricey.accepts[0]!.amount).toBe("250000");
  });
});

describe("GET /v1/prompts/:id — free tier (AE3)", () => {
  test("a free prompt returns full text and attribution with no payment", async () => {
    const app = makeApp();
    const freeEntry = catalog.entries.find((entry) => entry.body !== undefined)!;
    const res = await app.request(`/v1/prompts/${freeEntry.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tier).toBe("free");
    expect(body.text).toBe(freeEntry.body);
    expect(body.contentHash).toBe(freeEntry.contentHash);
    expect(body.attribution).toMatchObject({ source: freeEntry.attribution.source });

    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});

describe("GET /v1/prompts/:id — settlement outcomes", () => {
  test("a settle failure after successful verification returns an error and no text (R10)", async () => {
    facilitator.settleImpl = async () => ({
      success: false,
      errorReason: "invalid_exact_evm_insufficient_balance",
      errorMessage: "internal simulation detail that must not be forwarded",
      transaction: "",
      network: NETWORK,
      payer: PAYER,
    });
    const app = makeApp();
    const { res } = await paidRequest(app, PAID_LISTING.id);

    expect(res.status).toBe(402);
    const raw = await res.text();
    expect(raw).not.toContain(PAID_BODY.slice(0, 30));
    expect(raw).not.toContain("internal simulation detail");
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.error).toBe("settlement_failed");
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(1);

    // Verified-but-unsettled leaves the pre-settlement 'pending' row only:
    // no unlock claim, no tx hash.
    const row = getUnlock(db, PAYER, `0x${"77".repeat(32)}`);
    expect(row?.status).toBe("pending");
    expect(row?.tx_hash).toBeNull();
  });

  test("a handler failure after settlement records settled_but_undelivered and names the tx hash", async () => {
    const app = makeApp({
      deliver: () => {
        throw new Error("simulated delivery failure after settlement");
      },
    });
    const { res } = await paidRequest(app, PAID_LISTING.id);

    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain(PAID_BODY.slice(0, 30));
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.error).toBe("settled_but_undelivered");
    expect(body.txHash).toBe(TX_HASH);
    expect(body.message).toContain(TX_HASH);

    // The record is keyed on (payer, nonce) and carries the tx hash — a
    // charged buyer is a row, not a mystery.
    const row = getUnlock(db, PAYER, `0x${"77".repeat(32)}`);
    expect(row?.status).toBe("settled_but_undelivered");
    expect(row?.tx_hash).toBe(TX_HASH);
    expect(row?.prompt_id).toBe(PAID_LISTING.id);
  });

  test("a successful unlock returns text, tx hash, and content hash, and writes exactly one row (R9)", async () => {
    const app = makeApp();
    const { res } = await paidRequest(app, PAID_LISTING.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.text).toBe(PAID_BODY);
    expect(body.txHash).toBe(TX_HASH);
    expect(body.contentHash).toBe(PAID_LISTING.contentHash);
    expect(body.payer).toBe(PAYER);
    // The shared client also reads the settle result from the header.
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();

    const rows = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM unlocks`)
      .get()!;
    expect(rows.n).toBe(1);
    const row = getUnlock(db, PAYER, `0x${"77".repeat(32)}`);
    expect(row?.status).toBe("delivered");
    expect(row?.tx_hash).toBe(TX_HASH);
    expect(row?.amount_atomic).toBe(PAID_LISTING.priceAtomic);
  });

  test("a facilitator HTTP 500 (unknown scheme/network, §12) surfaces as a clean 402, not a crash", async () => {
    facilitator.verifyImpl = async () => {
      throw new VerifyError(500, {
        isValid: false,
        invalidReason: "unexpected_error",
        invalidMessage: "No facilitator registered for scheme: exact and network: eip155:1",
      });
    };
    const app = makeApp();
    const { res } = await paidRequest(app, PAID_LISTING.id);

    expect(res.status).toBe(402);
    const raw = await res.text();
    expect(raw).not.toContain(PAID_BODY.slice(0, 30));
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});

describe("GET /v1/prompts/:id — unknown ids", () => {
  test("an unknown id returns 404 before any payment is demanded", async () => {
    const app = makeApp();
    const res = await app.request("/v1/prompts/no-such-prompt");
    expect(res.status).toBe(404);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unknown_prompt_id");
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});

describe("mounted through createApp", () => {
  test("free tier and 404 work through the real app without payment configuration", async () => {
    const app = createApp({ catalog, db });
    const freeEntry = catalog.entries.find((entry) => entry.body !== undefined)!;

    const free = await app.request(`/v1/prompts/${freeEntry.id}`);
    expect(free.status).toBe(200);
    expect(((await free.json()) as { text: string }).text).toBe(freeEntry.body!);

    const missing = await app.request("/v1/prompts/no-such-prompt");
    expect(missing.status).toBe(404);
  });
});
