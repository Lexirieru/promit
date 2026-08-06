import { describe, expect, test } from "bun:test";
import {
  getListing,
  getPaidBody,
  getUnlock,
  insertListing,
  listListings,
  listingToPublicEntry,
  markSettledButUndelivered,
  markUnlockDelivered,
  openDb,
  recordUnlock,
  setPaidBody,
  type NewListing,
} from "./db.ts";

const memDb = () => openDb(":memory:");

const FAKE_HASH = `keccak256:${"ab".repeat(32)}`;

const LISTING: NewListing = {
  id: "neon-checkout-flow",
  title: "Neon Checkout Flow",
  category: "Landing Page",
  teaser: "A checkout page bathed in neon gradients.",
  media: "/media/neon-checkout-flow.webp",
  mediaType: "image",
  mediaStatus: "mirrored",
  poster: null,
  priceAtomic: "150000",
  tier: "paid",
  contentHash: FAKE_HASH,
  creatorAddress: "0x1111111111111111111111111111111111111111",
  signature: "0xsig",
};

describe("paid bodies", () => {
  test("set / get roundtrip, upsert overwrites", () => {
    const db = memDb();
    expect(getPaidBody(db, "x")).toBeNull();
    setPaidBody(db, "x", "secret prompt text");
    expect(getPaidBody(db, "x")).toBe("secret prompt text");
    setPaidBody(db, "x", "revised text");
    expect(getPaidBody(db, "x")).toBe("revised text");
  });
});

describe("unlocks", () => {
  const UNLOCK = {
    payer: "0xAbCd000000000000000000000000000000000001",
    paymentNonce: "0xnonce1",
    promptId: "neon-checkout-flow",
    amountAtomic: "150000",
    contentHash: FAKE_HASH,
  };

  test("replaying the same payer+nonce inserts exactly one row (R19)", () => {
    const db = memDb();
    expect(recordUnlock(db, UNLOCK)).toBe(true);
    expect(recordUnlock(db, UNLOCK)).toBe(false);
    // checksummed vs lowercase payer must hit the same row, not a second one
    expect(
      recordUnlock(db, { ...UNLOCK, payer: UNLOCK.payer.toLowerCase() }),
    ).toBe(false);
    expect(getUnlock(db, UNLOCK.payer, UNLOCK.paymentNonce)?.status).toBe(
      "pending",
    );
  });

  test("status transitions record the tx hash", () => {
    const db = memDb();
    recordUnlock(db, UNLOCK);
    markUnlockDelivered(db, UNLOCK.payer, UNLOCK.paymentNonce, "0xtx1");
    let row = getUnlock(db, UNLOCK.payer, UNLOCK.paymentNonce);
    expect(row?.status).toBe("delivered");
    expect(row?.tx_hash).toBe("0xtx1");

    markSettledButUndelivered(db, UNLOCK.payer, UNLOCK.paymentNonce, "0xtx1");
    row = getUnlock(db, UNLOCK.payer, UNLOCK.paymentNonce);
    expect(row?.status).toBe("settled_but_undelivered");
  });
});

describe("listings", () => {
  test("insert, fetch, and render as a public entry", () => {
    const db = memDb();
    insertListing(db, LISTING);
    const row = getListing(db, LISTING.id);
    expect(row).not.toBeNull();
    expect(listListings(db)).toHaveLength(1);

    const entry = listingToPublicEntry(row!);
    expect(entry.id).toBe(LISTING.id);
    expect(entry.tier).toBe("paid");
    expect(entry.attribution.source).toContain(LISTING.creatorAddress);
    // the rendered entry has no field that can carry prompt text
    expect(JSON.stringify(entry)).not.toContain("body");
  });

  test("duplicate content hash is rejected by the schema constraint (U7 dedup)", () => {
    const db = memDb();
    insertListing(db, LISTING);
    expect(() =>
      insertListing(db, { ...LISTING, id: "other-id-same-body" }),
    ).toThrow();
  });

  test("an invalid listing never enters the table", () => {
    const db = memDb();
    expect(() =>
      insertListing(db, {
        ...LISTING,
        media: "https://third-party.example/x.webp", // R5: never a third-party URL
      }),
    ).toThrow();
    expect(listListings(db)).toHaveLength(0);
  });
});
