import type { Database } from "bun:sqlite";

import { splitPayout } from "./fee";

/**
 * The creator payout queue.
 *
 * Like the settler (U10), the DATABASE is the queue: enqueueing is a scan of
 * rows other code already wrote, so nothing is lost if the worker is down, and
 * a restarted worker rediscovers its work. The primary key is `(payer,
 * payment_nonce)` — the same key `unlocks` uses — so one unlock can produce at
 * most one payout by construction rather than by discipline.
 *
 * Statuses:
 * - `pending`  — owed, nothing broadcast
 * - `sending`  — a transaction was about to be broadcast; see the note below
 * - `sent`     — confirmed on-chain, `tx_hash` set
 * - `flagged`  — needs a human, never retried automatically
 *
 * **`sending` is never auto-retried.** A USDC transfer has no idempotency key
 * a retry could reuse: if the process dies between broadcast and the write
 * that records the hash, the money may or may not have moved, and the two
 * cases are indistinguishable from the database alone. Retrying would pay
 * twice; assuming success would strand a creator. So a `sending` row found at
 * startup is flagged for a person to reconcile against the chain. Paying
 * twice is unrecoverable — the funds are gone — while a flagged row is a
 * five-minute check, so the asymmetry decides the default.
 */

export type PayoutStatus = "pending" | "sending" | "sent" | "flagged";

export interface PayoutRow {
  payer: string;
  paymentNonce: string;
  promptId: string;
  creatorAddress: string;
  grossAtomic: string;
  feeAtomic: string;
  netAtomic: string;
  status: PayoutStatus;
  txHash: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface RawPayoutRow {
  payer: string;
  payment_nonce: string;
  prompt_id: string;
  creator_address: string;
  gross_atomic: string;
  fee_atomic: string;
  net_atomic: string;
  status: PayoutStatus;
  tx_hash: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

const toRow = (raw: RawPayoutRow): PayoutRow => ({
  payer: raw.payer,
  paymentNonce: raw.payment_nonce,
  promptId: raw.prompt_id,
  creatorAddress: raw.creator_address,
  grossAtomic: raw.gross_atomic,
  feeAtomic: raw.fee_atomic,
  netAtomic: raw.net_atomic,
  status: raw.status,
  txHash: raw.tx_hash,
  attempts: raw.attempts,
  lastError: raw.last_error,
  createdAt: raw.created_at,
});

export function ensurePayoutSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS payouts (
      payer           TEXT NOT NULL,
      payment_nonce   TEXT NOT NULL,
      prompt_id       TEXT NOT NULL,
      creator_address TEXT NOT NULL,
      gross_atomic    TEXT NOT NULL,
      fee_atomic      TEXT NOT NULL,
      net_atomic      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'sent', 'flagged')),
      tx_hash         TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (payer, payment_nonce)
    );
    CREATE INDEX IF NOT EXISTS payouts_status ON payouts (status);
  `);
}

/**
 * Turns delivered unlocks into owed payouts.
 *
 * Only `delivered` counts. A `pending` row may never have settled, and
 * `settled_but_undelivered` is an open incident — paying a creator out of an
 * unlock the buyer never received would compound it. Seed entries are free
 * (R3), so a paid unlock always points at a creator listing; an unlock with no
 * listing row is skipped rather than guessed at.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` on the unlock's own key. Re-scanning is
 * free and safe, which is what lets the worker scan on a timer.
 */
export function enqueuePayouts(db: Database, feeBps: bigint, now: () => Date = () => new Date()): number {
  ensurePayoutSchema(db);
  const candidates = db
    .query<
      { payer: string; payment_nonce: string; prompt_id: string; amount_atomic: string; creator_address: string },
      []
    >(
      `SELECT u.payer, u.payment_nonce, u.prompt_id, u.amount_atomic, l.creator_address
         FROM unlocks u
         JOIN listings l ON l.id = u.prompt_id
        WHERE u.status = 'delivered'
          AND CAST(u.amount_atomic AS INTEGER) > 0
          AND NOT EXISTS (
            SELECT 1 FROM payouts p
             WHERE p.payer = u.payer AND p.payment_nonce = u.payment_nonce
          )`,
    )
    .all();

  const insert = db.prepare(
    `INSERT INTO payouts (payer, payment_nonce, prompt_id, creator_address,
                          gross_atomic, fee_atomic, net_atomic, created_at)
     VALUES ($payer, $nonce, $promptId, $creator, $gross, $fee, $net, $createdAt)
     ON CONFLICT (payer, payment_nonce) DO NOTHING`,
  );

  let inserted = 0;
  const createdAt = now().toISOString();
  for (const row of candidates) {
    const split = splitPayout(BigInt(row.amount_atomic), feeBps);
    inserted += insert.run({
      payer: row.payer.toLowerCase(),
      nonce: row.payment_nonce,
      promptId: row.prompt_id,
      creator: row.creator_address,
      gross: split.grossAtomic.toString(),
      fee: split.feeAtomic.toString(),
      net: split.netAtomic.toString(),
      createdAt: createdAt,
    }).changes;
  }
  return inserted;
}

export function listPayouts(db: Database, status?: PayoutStatus): PayoutRow[] {
  ensurePayoutSchema(db);
  const raws = status
    ? db.query<RawPayoutRow, [PayoutStatus]>(`SELECT * FROM payouts WHERE status = ?`).all(status)
    : db.query<RawPayoutRow, []>(`SELECT * FROM payouts`).all();
  return raws.map(toRow);
}

/** Total still owed to creators, for the worker's balance preflight. */
export function pendingNetTotal(db: Database): bigint {
  return listPayouts(db, "pending").reduce((sum, row) => sum + BigInt(row.netAtomic), 0n);
}

/**
 * Marks a row as about to be broadcast. Written and committed BEFORE the
 * transaction leaves, so a crash mid-broadcast leaves evidence rather than an
 * innocent-looking `pending` row that the next scan would happily pay again.
 */
export function markSending(db: Database, payer: string, nonce: string): void {
  db.run(
    `UPDATE payouts SET status = 'sending', attempts = attempts + 1
      WHERE payer = $payer AND payment_nonce = $nonce AND status = 'pending'`,
    { payer: payer.toLowerCase(), nonce: nonce },
  );
}

export function markSent(db: Database, payer: string, nonce: string, txHash: string): void {
  db.run(
    `UPDATE payouts SET status = 'sent', tx_hash = $txHash, last_error = NULL
      WHERE payer = $payer AND payment_nonce = $nonce`,
    { payer: payer.toLowerCase(), nonce: nonce, txHash: txHash },
  );
}

export function markFlagged(db: Database, payer: string, nonce: string, reason: string): void {
  db.run(
    `UPDATE payouts SET status = 'flagged', last_error = $reason
      WHERE payer = $payer AND payment_nonce = $nonce`,
    { payer: payer.toLowerCase(), nonce: nonce, reason: reason },
  );
}

/**
 * Called once at startup. Any row still `sending` belongs to a process that
 * died mid-broadcast, and no amount of database reading can tell whether the
 * money moved — so it becomes a human's problem instead of a silent double
 * payment. Returns the rows flagged, so the worker can log them loudly.
 */
export function flagInterruptedSends(db: Database): PayoutRow[] {
  ensurePayoutSchema(db);
  const stranded = listPayouts(db, "sending");
  for (const row of stranded) {
    markFlagged(
      db,
      row.payer,
      row.paymentNonce,
      "process died after the payout was marked for broadcast; check the treasury's " +
        "transaction history for this creator before releasing it manually",
    );
  }
  return stranded;
}
