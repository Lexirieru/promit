import type { Database } from "bun:sqlite";

/**
 * The settler's persistent job queue (U10). The queue is DB-backed, not
 * in-memory, because the whole point of asynchronous recording is that the
 * buyer's request has already returned — a crash between settlement and the
 * registry write must lose nothing. WAL mode (set in db.ts) lets this run in
 * a separate process from the API.
 *
 * Enqueueing is a SCAN of the rows U4 and U7 already write, not a message
 * from the request path: any settled unlock (`status` past 'pending',
 * `onchain_tx_hash` NULL) and any listing without `onchain_tx_hash` IS the
 * work list. The PRIMARY KEY on (kind, ref) makes the scan idempotent — a
 * settled unlock enqueues exactly one recording job no matter how many times
 * the scan runs.
 *
 * Job states:
 * - 'pending' — waiting to run (possibly gated by `not_before` backoff)
 * - 'done'    — recorded on-chain (or found already recorded)
 * - 'flagged' — needs a human: definitive evidence something is wrong, e.g.
 *   the facilitator reported a tx hash the chain never saw. Flagged jobs are
 *   never retried automatically; retrying cannot fix them.
 */

export type JobKind = "register_listing" | "record_unlock";
export type JobStatus = "pending" | "done" | "flagged";

export interface JobRow {
  kind: JobKind;
  ref: string;
  status: JobStatus;
  attempts: number;
  /**
   * Times the chain answered "no such transaction" for the facilitator's tx
   * hash. Counted separately from `attempts`, which also grows on RPC
   * outages — an unreachable chain must never accumulate toward the
   * "facilitator lied" flag.
   */
  receipt_misses: number;
  not_before: string | null;
  last_error: string | null;
  created_at: string;
}

const SETTLER_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS settler_jobs (
  kind       TEXT NOT NULL CHECK (kind IN ('register_listing', 'record_unlock')),
  ref        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'flagged')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  receipt_misses INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (kind, ref)
);

-- prompt id -> on-chain listing id. recordUnlock() needs the registry's
-- numeric listingId, which exists nowhere else off-chain: the listings table
-- keys on slug ids and the contract assigns ids sequentially at registration.
CREATE TABLE IF NOT EXISTS settler_onchain_listings (
  prompt_id  TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  tx_hash    TEXT
);
`;

export function ensureSettlerTables(db: Database): void {
  db.exec(SETTLER_SCHEMA);
}

/**
 * The unlock job ref packs the row's composite PK. payer is stored
 * lowercased by db.ts, and nonces are 0x-hex, so "\n" can appear in neither.
 */
export function unlockRef(payer: string, paymentNonce: string): string {
  return `${payer.toLowerCase()}\n${paymentNonce}`;
}

export function parseUnlockRef(ref: string): { payer: string; paymentNonce: string } {
  const [payer = "", paymentNonce = ""] = ref.split("\n");
  return { payer, paymentNonce };
}

/** Scan the U4/U7 tables for work and enqueue anything not yet queued. */
export function enqueueScan(db: Database): number {
  const insert = db.query(
    `INSERT INTO settler_jobs (kind, ref) VALUES ($kind, $ref)
     ON CONFLICT (kind, ref) DO NOTHING`,
  );
  let enqueued = 0;

  const listings = db
    .query<{ id: string }, []>(`SELECT id FROM listings WHERE onchain_tx_hash IS NULL`)
    .all();
  for (const { id } of listings) {
    enqueued += insert.run({ kind: "register_listing", ref: id }).changes;
  }

  // 'pending' is excluded on purpose: money has not provably moved yet.
  // Both post-settlement states qualify — settled_but_undelivered is still a
  // settled payment (R10: recorded rather than lost).
  const unlocks = db
    .query<{ payer: string; payment_nonce: string }, []>(
      `SELECT payer, payment_nonce FROM unlocks
       WHERE status IN ('delivered', 'settled_but_undelivered')
         AND onchain_tx_hash IS NULL`,
    )
    .all();
  for (const row of unlocks) {
    enqueued += insert.run({
      kind: "record_unlock",
      ref: unlockRef(row.payer, row.payment_nonce),
    }).changes;
  }

  return enqueued;
}

/**
 * Pending jobs whose backoff gate has passed. Listings come first: a
 * record_unlock job for a fresh listing needs the on-chain listingId its
 * register_listing job produces, and ordering them lets both complete in a
 * single drain pass.
 */
export function dueJobs(db: Database, nowIso: string): JobRow[] {
  return db
    .query<JobRow, { now: string }>(
      `SELECT * FROM settler_jobs
       WHERE status = 'pending' AND (not_before IS NULL OR not_before <= $now)
       ORDER BY CASE kind WHEN 'register_listing' THEN 0 ELSE 1 END, created_at, ref`,
    )
    .all({ now: nowIso });
}

export function getJob(db: Database, kind: JobKind, ref: string): JobRow | null {
  return (
    db
      .query<JobRow, { kind: string; ref: string }>(
        `SELECT * FROM settler_jobs WHERE kind = $kind AND ref = $ref`,
      )
      .get({ kind, ref }) ?? null
  );
}

export function listJobs(db: Database): JobRow[] {
  return db
    .query<JobRow, []>(`SELECT * FROM settler_jobs ORDER BY created_at, kind, ref`)
    .all();
}

export function markJobDone(db: Database, kind: JobKind, ref: string): void {
  db.query(
    `UPDATE settler_jobs SET status = 'done', not_before = NULL, last_error = NULL
     WHERE kind = $kind AND ref = $ref`,
  ).run({ kind, ref });
}

export function markJobFlagged(db: Database, kind: JobKind, ref: string, error: string): void {
  db.query(
    `UPDATE settler_jobs SET status = 'flagged', last_error = $error
     WHERE kind = $kind AND ref = $ref`,
  ).run({ kind, ref, error });
}

/**
 * Records one definitive "the chain has no such transaction" observation and
 * returns the running count. The caller flags once the count crosses its
 * threshold; below it the job retries, because the settler's RPC node may
 * simply lag the facilitator's by a few blocks.
 */
export function recordReceiptMiss(db: Database, kind: JobKind, ref: string): number {
  db.query(
    `UPDATE settler_jobs SET receipt_misses = receipt_misses + 1
     WHERE kind = $kind AND ref = $ref`,
  ).run({ kind, ref });
  return getJob(db, kind, ref)?.receipt_misses ?? 0;
}

/** Failure stays 'pending': the job is deferred, never lost. */
export function markJobRetry(
  db: Database,
  kind: JobKind,
  ref: string,
  error: string,
  notBeforeIso: string,
): void {
  db.query(
    `UPDATE settler_jobs
     SET attempts = attempts + 1, not_before = $notBefore, last_error = $error
     WHERE kind = $kind AND ref = $ref`,
  ).run({ kind, ref, error, notBefore: notBeforeIso });
}

// ---------------------------------------------------------------------------
// on-chain listing id mapping

export interface OnchainListingRow {
  prompt_id: string;
  listing_id: string;
  tx_hash: string | null;
}

export function getOnchainListing(db: Database, promptId: string): OnchainListingRow | null {
  return (
    db
      .query<OnchainListingRow, { promptId: string }>(
        `SELECT * FROM settler_onchain_listings WHERE prompt_id = $promptId`,
      )
      .get({ promptId }) ?? null
  );
}

export function putOnchainListing(
  db: Database,
  promptId: string,
  listingId: bigint,
  txHash: string | null,
): void {
  db.query(
    `INSERT INTO settler_onchain_listings (prompt_id, listing_id, tx_hash)
     VALUES ($promptId, $listingId, $txHash)
     ON CONFLICT (prompt_id) DO UPDATE SET listing_id = excluded.listing_id,
                                           tx_hash = excluded.tx_hash`,
  ).run({ promptId, listingId: listingId.toString(), txHash });
}

// ---------------------------------------------------------------------------
// completion marks on the U4/U7 rows (columns db.ts reserves for U10)

export function setUnlockOnchainTxHash(
  db: Database,
  payer: string,
  paymentNonce: string,
  txHash: string,
): void {
  db.query(
    `UPDATE unlocks SET onchain_tx_hash = $txHash
     WHERE payer = $payer AND payment_nonce = $paymentNonce`,
  ).run({ payer: payer.toLowerCase(), paymentNonce, txHash });
}

export function setListingOnchainTxHash(db: Database, id: string, txHash: string): void {
  db.query(`UPDATE listings SET onchain_tx_hash = $txHash WHERE id = $id`).run({ id, txHash });
}
