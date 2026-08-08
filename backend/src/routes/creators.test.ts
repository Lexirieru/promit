import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createApp } from "../index.ts";
import { insertListing, markUnlockDelivered, openDb, recordUnlock } from "../db.ts";
import { enqueuePayouts, markSent } from "../payouts/queue.ts";
import { DEFAULT_FEE_BPS } from "../payouts/fee.ts";

const CREATOR = "0xadE939F26516c657fc01f2eD1B069562b672644c";
const OTHER_CREATOR = "0x1111111111111111111111111111111111111111";
const BUYER_A = "0xFA128bBD1846c19025c7428AEE403Fc06F0A9e38";
const BUYER_B = "0x2222222222222222222222222222222222222222";

let hashSeed = 0;
const nextHash = () => `keccak256:${(++hashSeed).toString(16).padStart(64, "0")}`;

let db: Database;

function listing(id: string, creator = CREATOR, priceAtomic = "100000"): void {
  insertListing(db, {
    id,
    title: `Title ${id}`,
    category: "Hero",
    teaser: "teaser",
    media: `/media/uploads/${id}.mp4`,
    mediaType: "video",
    mediaStatus: "mirrored",
    poster: null,
    priceAtomic,
    tier: "paid",
    contentHash: nextHash(),
    creatorAddress: creator,
    signature: "0xsig",
  });
}

function sale(promptId: string, buyer: string, nonce: string, deliver = true): void {
  recordUnlock(db, {
    payer: buyer,
    paymentNonce: nonce,
    promptId,
    amountAtomic: "100000",
    contentHash: nextHash(),
  });
  if (deliver) markUnlockDelivered(db, buyer, nonce, "0xsettletx");
}

interface Dashboard {
  creator: string;
  feeLabel: string;
  totals: Record<string, string | number>;
  listings: Record<string, string | number | null>[];
}

const get = (address: string) => createApp({ db }).request(`/v1/creators/${address}`);
/** Typed read, so an assertion on a renamed field fails at compile time. */
const dashboard = async (address: string): Promise<Dashboard> =>
  (await (await get(address)).json()) as Dashboard;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("GET /v1/creators/:address", () => {
  test("counts buyers and sales, and splits the earnings", async () => {
    listing("hero-a");
    sale("hero-a", BUYER_A, "0xn1");
    sale("hero-a", BUYER_B, "0xn2");

    const body = await dashboard(CREATOR);

    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]).toMatchObject({
      id: "hero-a",
      buyers: 2,
      sales: 2,
      grossAtomic: "200000",
      feeAtomic: "5000",
      netAtomic: "195000",
      paidAtomic: "0",
      claimableAtomic: "195000",
    });
    expect(body.feeLabel).toBe("2.5%");
  });

  test("one wallet buying twice is one buyer but two sales", async () => {
    // The distinction a creator actually cares about: repeat custom versus
    // reach. Collapsing them would overstate the audience.
    listing("hero-a");
    sale("hero-a", BUYER_A, "0xn1");
    sale("hero-a", BUYER_A, "0xn2");

    const body = await dashboard(CREATOR);

    expect(body.listings[0]).toMatchObject({ buyers: 1, sales: 2 });
  });

  test("a listing with no sales still appears, at zero", async () => {
    // "Nobody bought yet" and "you listed nothing" are different messages,
    // and only one of them is true here.
    listing("hero-a");

    const body = await dashboard(CREATOR);

    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]).toMatchObject({ buyers: 0, sales: 0, claimableAtomic: "0" });
  });

  test("undelivered unlocks are not counted as earnings", async () => {
    listing("hero-a");
    sale("hero-a", BUYER_A, "0xn1", false); // pending: may never have settled

    const body = await dashboard(CREATOR);

    expect(body.listings[0]).toMatchObject({ sales: 0, grossAtomic: "0" });
  });

  test("what was already paid moves out of claimable", async () => {
    listing("hero-a");
    sale("hero-a", BUYER_A, "0xn1");
    enqueuePayouts(db, DEFAULT_FEE_BPS);
    markSent(db, BUYER_A, "0xn1", "0xpayout");

    const body = await dashboard(CREATOR);

    expect(body.listings[0]).toMatchObject({
      netAtomic: "97500",
      paidAtomic: "97500",
      claimableAtomic: "0",
    });
    expect(body.totals.claimableAtomic).toBe("0");
  });

  test("another creator's listings and sales never leak in", async () => {
    listing("hero-a");
    listing("hero-b", OTHER_CREATOR);
    sale("hero-b", BUYER_A, "0xn1");

    const body = await dashboard(CREATOR);

    expect(body.listings.map((l) => l.id)).toEqual(["hero-a"]);
    expect(body.totals.grossAtomic).toBe("0");
  });

  test("address casing does not change the answer", async () => {
    listing("hero-a");
    sale("hero-a", BUYER_A, "0xn1");

    const lower = await dashboard(CREATOR.toLowerCase());
    const upper = await dashboard(CREATOR.toUpperCase().replace("0X", "0x"));

    expect(upper.totals).toEqual(lower.totals);
  });

  test("totals add up across listings", async () => {
    listing("hero-a");
    listing("hero-b");
    sale("hero-a", BUYER_A, "0xn1");
    sale("hero-b", BUYER_B, "0xn2");

    const body = await dashboard(CREATOR);

    expect(body.totals).toMatchObject({
      listings: 2,
      sales: 2,
      buyers: 2,
      grossAtomic: "200000",
      netAtomic: "195000",
      claimableAtomic: "195000",
    });
  });

  test("a malformed address is refused, not treated as a creator with nothing", async () => {
    const response = await get("not-an-address");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_address" });
  });

  test("an unknown creator is an empty dashboard, not an error", async () => {
    const response = await get(OTHER_CREATOR);

    expect(response.status).toBe(200);
    expect((await dashboard(OTHER_CREATOR)).listings).toEqual([]);
  });

  test("never returns prompt text", async () => {
    // The paywall rule holds on every route: text leaves through
    // /v1/prompts/:id alone, and a creator dashboard is not an exception.
    listing("hero-a");
    sale("hero-a", BUYER_A, "0xn1");

    const raw = await (await get(CREATOR)).text();

    expect(raw).not.toContain("body");
    expect(raw).not.toContain("text");
  });
});
