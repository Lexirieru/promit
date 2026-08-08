import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDb, insertListing, recordUnlock, markUnlockDelivered } from "../db";
import { DEFAULT_FEE_BPS } from "./fee";
import {
  enqueuePayouts,
  flagInterruptedSends,
  listPayouts,
  markFlagged,
  markSending,
  markSent,
  pendingNetTotal,
} from "./queue";

const CREATOR = "0xadE939F26516c657fc01f2eD1B069562b672644c";
const PAYER = "0xFA128bBD1846c19025c7428AEE403Fc06F0A9e38";

/** Valid 64-hex digest; the schema rejects anything else. */
let hashSeed = 0;
const nextHash = () => `keccak256:${(++hashSeed).toString(16).padStart(64, "0")}`;

let db: Database;

function seedListing(id: string, priceAtomic = "100000"): void {
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
    creatorAddress: CREATOR,
    signature: "0xsig",
    createdAt: new Date("2026-08-08T00:00:00.000Z").toISOString(),
  });
}

function deliveredUnlock(promptId: string, nonce: string, amount = "100000"): void {
  recordUnlock(db, {
    payer: PAYER,
    paymentNonce: nonce,
    promptId,
    amountAtomic: amount,
    contentHash: nextHash(),
  });
  markUnlockDelivered(db, PAYER, nonce, "0xtx");
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("enqueuePayouts", () => {
  test("turns a delivered paid unlock into an owed payout with the fee applied", () => {
    seedListing("hero-a");
    deliveredUnlock("hero-a", "0xnonce1");

    expect(enqueuePayouts(db, DEFAULT_FEE_BPS)).toBe(1);

    const [row] = listPayouts(db);
    expect(row).toMatchObject({
      promptId: "hero-a",
      creatorAddress: CREATOR,
      grossAtomic: "100000",
      feeAtomic: "2500",
      netAtomic: "97500",
      status: "pending",
      txHash: null,
    });
  });

  test("re-scanning enqueues nothing new", () => {
    seedListing("hero-a");
    deliveredUnlock("hero-a", "0xnonce1");
    enqueuePayouts(db, DEFAULT_FEE_BPS);

    // The scan runs on a timer, so idempotence is not a nicety — a second
    // pass that inserted again would pay the creator twice for one sale.
    expect(enqueuePayouts(db, DEFAULT_FEE_BPS)).toBe(0);
    expect(listPayouts(db)).toHaveLength(1);
  });

  test("skips unlocks that were never delivered", () => {
    seedListing("hero-a");
    // pending: settlement may never have happened.
    recordUnlock(db, {
      payer: PAYER,
      paymentNonce: "0xnonce-pending",
      promptId: "hero-a",
      amountAtomic: "100000",
      contentHash: nextHash(),
    });

    expect(enqueuePayouts(db, DEFAULT_FEE_BPS)).toBe(0);
  });

  test("skips an unlock with no listing rather than guessing a recipient", () => {
    deliveredUnlock("prompt-with-no-listing", "0xnonce1");

    expect(enqueuePayouts(db, DEFAULT_FEE_BPS)).toBe(0);
  });

  test("two unlocks of the same prompt owe two payouts", () => {
    seedListing("hero-a");
    deliveredUnlock("hero-a", "0xnonce1");
    deliveredUnlock("hero-a", "0xnonce2");

    expect(enqueuePayouts(db, DEFAULT_FEE_BPS)).toBe(2);
    expect(pendingNetTotal(db)).toBe(195_000n);
  });

  test("a zero fee owes the creator the full gross", () => {
    seedListing("hero-a");
    deliveredUnlock("hero-a", "0xnonce1");

    enqueuePayouts(db, 0n);

    expect(listPayouts(db)[0]).toMatchObject({ feeAtomic: "0", netAtomic: "100000" });
  });
});

describe("status transitions", () => {
  beforeEach(() => {
    seedListing("hero-a");
    deliveredUnlock("hero-a", "0xnonce1");
    enqueuePayouts(db, DEFAULT_FEE_BPS);
  });

  test("markSending only claims a pending row, and counts the attempt", () => {
    markSending(db, PAYER, "0xnonce1");
    expect(listPayouts(db)[0]).toMatchObject({ status: "sending", attempts: 1 });

    // Already claimed: a second claim must not bump the attempt again, or a
    // loop could quietly re-broadcast a payout that is already in flight.
    markSending(db, PAYER, "0xnonce1");
    expect(listPayouts(db)[0]).toMatchObject({ status: "sending", attempts: 1 });
  });

  test("markSent records the hash and clears any previous error", () => {
    markFlagged(db, PAYER, "0xnonce1", "earlier trouble");
    markSent(db, PAYER, "0xnonce1", "0xpayouttx");

    expect(listPayouts(db)[0]).toMatchObject({
      status: "sent",
      txHash: "0xpayouttx",
      lastError: null,
    });
  });

  test("payer casing cannot create a second row or miss an update", () => {
    // unlocks lowercases its payer on every access (R19); payouts must agree
    // or an EIP-55 address would look like a different creditor.
    markSent(db, PAYER.toUpperCase(), "0xnonce1", "0xpayouttx");

    expect(listPayouts(db)).toHaveLength(1);
    expect(listPayouts(db)[0]!.status).toBe("sent");
  });
});

describe("flagInterruptedSends", () => {
  test("a row stranded in sending is flagged, never silently retried", () => {
    seedListing("hero-a");
    deliveredUnlock("hero-a", "0xnonce1");
    enqueuePayouts(db, DEFAULT_FEE_BPS);
    markSending(db, PAYER, "0xnonce1");

    // Simulates the process dying between broadcast and the write that would
    // have recorded the hash. The chain may or may not hold a transfer, and
    // nothing in the database can tell the two apart — so a person decides.
    const stranded = flagInterruptedSends(db);

    expect(stranded).toHaveLength(1);
    const [row] = listPayouts(db);
    expect(row!.status).toBe("flagged");
    expect(row!.lastError).toContain("check the treasury");
    // Critically: not back to pending, which the next scan would pay again.
    expect(listPayouts(db, "pending")).toHaveLength(0);
  });

  test("leaves pending and sent rows alone", () => {
    seedListing("hero-a");
    deliveredUnlock("hero-a", "0xnonce1");
    deliveredUnlock("hero-a", "0xnonce2");
    enqueuePayouts(db, DEFAULT_FEE_BPS);
    markSent(db, PAYER, "0xnonce2", "0xtx");

    expect(flagInterruptedSends(db)).toHaveLength(0);
    expect(listPayouts(db, "pending")).toHaveLength(1);
    expect(listPayouts(db, "sent")).toHaveLength(1);
  });
});
