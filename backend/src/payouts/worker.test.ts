import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { insertListing, markUnlockDelivered, openDb, recordUnlock } from "../db";
import { PayoutPreflightError, preflight, type PayoutChain } from "./chain";
import { DEFAULT_FEE_BPS } from "./fee";
import { listPayouts, markSending, enqueuePayouts } from "./queue";
import { runPayouts } from "./index";

const CREATOR = "0xadE939F26516c657fc01f2eD1B069562b672644c";
const PAYER = "0xFA128bBD1846c19025c7428AEE403Fc06F0A9e38";
const TREASURY = "0x56A2950ddE6B1040d1DCC4b4C4Fc314Bd56eFB0E";

let hashSeed = 0;
const nextHash = () => `keccak256:${(++hashSeed).toString(16).padStart(64, "0")}`;

let db: Database;

/**
 * Counts transfers. The count is the assertion that matters: "did not pay
 * twice" is only provable by a fake that would have noticed.
 */
function fakeChain(overrides: Partial<PayoutChain> & { sends?: string[] } = {}): PayoutChain & {
  sends: { to: string; amount: bigint }[];
} {
  const sends: { to: string; amount: bigint }[] = [];
  return {
    sends,
    treasuryAddress: TREASURY,
    usdcBalance: async () => 10_000_000n,
    ethBalance: async () => 10_000_000_000_000_000n,
    sendUsdc: async (to, amount) => {
      sends.push({ to, amount });
      return `0xtx${sends.length}`;
    },
    confirm: async () => true,
    ...overrides,
  } as PayoutChain & { sends: { to: string; amount: bigint }[] };
}

function owedUnlock(nonce: string, promptId = "hero-a"): void {
  recordUnlock(db, {
    payer: PAYER,
    paymentNonce: nonce,
    promptId,
    amountAtomic: "100000",
    contentHash: nextHash(),
  });
  markUnlockDelivered(db, PAYER, nonce, "0xsettletx");
}

beforeEach(() => {
  db = openDb(":memory:");
  insertListing(db, {
    id: "hero-a",
    title: "Hero A",
    category: "Hero",
    teaser: "teaser",
    media: "/media/uploads/hero-a.mp4",
    mediaType: "video",
    mediaStatus: "mirrored",
    poster: null,
    priceAtomic: "100000",
    tier: "paid",
    contentHash: nextHash(),
    creatorAddress: CREATOR,
    signature: "0xsig",
  });
});

const run = (chain: PayoutChain, extra: Partial<Parameters<typeof runPayouts>[0]> = {}) =>
  runPayouts({ db, chain, payTo: TREASURY, feeBps: DEFAULT_FEE_BPS, log: () => {}, ...extra });

describe("runPayouts", () => {
  test("pays the creator the gross minus the fee", async () => {
    owedUnlock("0xn1");
    const chain = fakeChain();

    const result = await run(chain);

    expect(result).toMatchObject({ enqueued: 1, sent: 1, flagged: 0 });
    expect(chain.sends).toEqual([{ to: CREATOR, amount: 97_500n }]);
    expect(listPayouts(db)[0]).toMatchObject({ status: "sent", txHash: "0xtx1" });
  });

  test("a second run pays nothing again", async () => {
    owedUnlock("0xn1");
    const chain = fakeChain();
    await run(chain);

    await run(chain);

    // The whole point of the queue. One sale, one transfer, forever.
    expect(chain.sends).toHaveLength(1);
  });

  test("a reverted transfer is flagged, not retried", async () => {
    owedUnlock("0xn1");
    const chain = fakeChain({ confirm: async () => false });

    const first = await run(chain);
    expect(first).toMatchObject({ sent: 0, flagged: 1 });

    await run(chain);
    expect(chain.sends).toHaveLength(1);
    expect(listPayouts(db)[0]!.status).toBe("flagged");
  });

  test("a send that throws leaves the row flagged with the outcome unknown", async () => {
    owedUnlock("0xn1");
    const chain = fakeChain({
      sendUsdc: async () => {
        throw new Error("connection reset");
      },
    });

    const result = await run(chain);

    expect(result.flagged).toBe(1);
    const [row] = listPayouts(db);
    // A dropped connection after the node accepted the transaction looks
    // identical to a refusal, so the row must not return to pending.
    expect(row!.status).toBe("flagged");
    expect(row!.lastError).toContain("outcome unknown");
  });

  test("a row stranded in sending is flagged before the drain and never sent", async () => {
    owedUnlock("0xn1");
    enqueuePayouts(db, DEFAULT_FEE_BPS);
    markSending(db, PAYER, "0xn1"); // previous process died here
    const chain = fakeChain();

    const result = await run(chain);

    expect(result.stranded).toHaveLength(1);
    expect(chain.sends).toHaveLength(0);
    expect(listPayouts(db)[0]!.status).toBe("flagged");
  });

  test("pays each unlock of the same prompt separately", async () => {
    owedUnlock("0xn1");
    owedUnlock("0xn2");
    const chain = fakeChain();

    await run(chain);

    expect(chain.sends).toEqual([
      { to: CREATOR, amount: 97_500n },
      { to: CREATOR, amount: 97_500n },
    ]);
  });

  test("a treasury that cannot cover what is owed sends nothing and keeps rows pending", async () => {
    owedUnlock("0xn1");
    const chain = fakeChain({ usdcBalance: async () => 1n });

    const result = await run(chain);

    expect(chain.sends).toHaveLength(0);
    expect(result.sent).toBe(0);
    // Pending, not flagged: funding is a machine problem that fixes itself
    // when the treasury is topped up. Flagging would demand a human for it.
    expect(listPayouts(db, "pending")).toHaveLength(1);
  });

  test("does nothing when no unlock is owed", async () => {
    const chain = fakeChain();

    expect(await run(chain)).toMatchObject({ enqueued: 0, sent: 0 });
    expect(chain.sends).toHaveLength(0);
  });
});

describe("preflight", () => {
  test("refuses when the key is not the wallet buyers paid", async () => {
    // Otherwise creators get paid out of an unrelated wallet while the
    // treasury silently accumulates what it owes.
    const chain = fakeChain({ treasuryAddress: "0x0000000000000000000000000000000000000001" });

    await expect(preflight({ chain, payTo: TREASURY, owedAtomic: 0n })).rejects.toThrow(
      PayoutPreflightError,
    );
  });

  test("accepts a treasury address that differs only in EIP-55 casing", async () => {
    const chain = fakeChain({ treasuryAddress: TREASURY.toLowerCase() });

    await expect(
      preflight({ chain, payTo: TREASURY.toUpperCase(), owedAtomic: 0n }),
    ).resolves.toBeUndefined();
  });

  test("refuses without enough gas to finish the drain", async () => {
    const chain = fakeChain({ ethBalance: async () => 1n });

    await expect(preflight({ chain, payTo: TREASURY, owedAtomic: 0n })).rejects.toMatchObject({
      code: "treasury_out_of_gas",
    });
  });
});
