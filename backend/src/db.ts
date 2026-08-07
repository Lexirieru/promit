import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import type { PublicCatalogEntry } from "./catalog/index.ts";
import { PublicCatalogEntrySchema } from "./catalog/index.ts";

/**
 * The runtime store (KTD17): everything that cannot live in the versioned
 * catalog file lands here. Three tables, three writers:
 *
 * - `paid_bodies`  — prompt text for paid entries, seed-derived or
 *   creator-submitted. Written by U4/U7, read only by the unlock route.
 *   Committing paid text would make it readable to anyone who clones the
 *   repo and it would survive in git history after deletion.
 * - `unlocks`      — one row per settled purchase, keyed on
 *   (payer, payment_nonce) so a replayed payment is one row, not two (R19).
 *   Written by U4, drained onto the chain by U10.
 * - `listings`     — creator-submitted catalog entries (U7). The public
 *   catalog id space is the union of seed entries and these rows.
 *
 * There is no FK from `unlocks.prompt_id` or `paid_bodies.prompt_id` to a
 * catalog table because seed entries live in `data/catalog.json`, not in
 * SQLite — referential integrity across that union is enforced in the
 * routes, not the schema.
 */

/**
 * `PROMIT_DB_PATH` overrides the location so a host can point the store at a
 * mounted volume. Without it, a platform that redeploys from a fresh image
 * loses every paid body and unlock record on each deploy — the repo-relative
 * default only survives because a dev box keeps the same working tree.
 */
export const DEFAULT_DB_PATH =
  process.env.PROMIT_DB_PATH ??
  fileURLToPath(new URL("../data/promit.sqlite", import.meta.url));

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS paid_bodies (
  prompt_id TEXT PRIMARY KEY,
  body      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unlocks (
  payer          TEXT NOT NULL,
  payment_nonce  TEXT NOT NULL,
  prompt_id      TEXT NOT NULL,
  amount_atomic  TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  -- 'pending': row written before settlement is invoked (U4's ordering rule).
  -- 'delivered': body returned to the buyer.
  -- 'settled_but_undelivered': money moved, body did not — the row U4's
  -- onAfterSettle hook emits so a charged-but-empty-handed buyer is a
  -- record, not a mystery.
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'delivered', 'settled_but_undelivered')),
  tx_hash        TEXT,
  -- set by U10's settler once the unlock is recorded in PromitRegistry
  onchain_tx_hash TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (payer, payment_nonce)
);

CREATE TABLE IF NOT EXISTS listings (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  category        TEXT NOT NULL,
  teaser          TEXT NOT NULL,
  media           TEXT,
  media_type      TEXT NOT NULL,
  media_status    TEXT NOT NULL,
  poster          TEXT,
  price_atomic    TEXT NOT NULL,
  tier            TEXT NOT NULL DEFAULT 'paid' CHECK (tier IN ('free', 'paid')),
  -- UNIQUE so U7's duplicate-body detection is a constraint, not a query
  content_hash    TEXT NOT NULL UNIQUE,
  creator_address TEXT NOT NULL,
  signature       TEXT NOT NULL,
  -- set by U10 once the listing's content hash is registered on-chain
  onchain_tx_hash TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

export function openDb(path: string = DEFAULT_DB_PATH): Database {
  const db = new Database(path, { create: true, strict: true });
  // WAL lets the settler worker (U10) read while the API writes.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// paid bodies

export function setPaidBody(db: Database, promptId: string, body: string): void {
  db.query(
    `INSERT INTO paid_bodies (prompt_id, body) VALUES ($promptId, $body)
     ON CONFLICT (prompt_id) DO UPDATE SET body = excluded.body`,
  ).run({ promptId, body });
}

export function getPaidBody(db: Database, promptId: string): string | null {
  const row = db
    .query<{ body: string }, { promptId: string }>(
      `SELECT body FROM paid_bodies WHERE prompt_id = $promptId`,
    )
    .get({ promptId });
  return row?.body ?? null;
}

// ---------------------------------------------------------------------------
// unlocks

export interface NewUnlock {
  payer: string;
  paymentNonce: string;
  promptId: string;
  amountAtomic: string;
  contentHash: string;
}

export interface UnlockRow {
  payer: string;
  payment_nonce: string;
  prompt_id: string;
  amount_atomic: string;
  content_hash: string;
  status: "pending" | "delivered" | "settled_but_undelivered";
  tx_hash: string | null;
  onchain_tx_hash: string | null;
  created_at: string;
}

/**
 * Payer addresses are lowercased on every access so an EIP-55 checksummed
 * address and its lowercase form cannot defeat the (payer, nonce)
 * idempotency key by being two distinct rows.
 */
export function recordUnlock(db: Database, unlock: NewUnlock): boolean {
  const changes = db
    .query(
      `INSERT INTO unlocks (payer, payment_nonce, prompt_id, amount_atomic, content_hash)
       VALUES ($payer, $paymentNonce, $promptId, $amountAtomic, $contentHash)
       ON CONFLICT (payer, payment_nonce) DO NOTHING`,
    )
    .run({ ...unlock, payer: unlock.payer.toLowerCase() });
  return changes.changes > 0;
}

export function getUnlock(
  db: Database,
  payer: string,
  paymentNonce: string,
): UnlockRow | null {
  return (
    db
      .query<UnlockRow, { payer: string; paymentNonce: string }>(
        `SELECT * FROM unlocks WHERE payer = $payer AND payment_nonce = $paymentNonce`,
      )
      .get({ payer: payer.toLowerCase(), paymentNonce }) ?? null
  );
}

export function markUnlockDelivered(
  db: Database,
  payer: string,
  paymentNonce: string,
  txHash: string,
): void {
  db.query(
    `UPDATE unlocks SET status = 'delivered', tx_hash = $txHash
     WHERE payer = $payer AND payment_nonce = $paymentNonce`,
  ).run({ payer: payer.toLowerCase(), paymentNonce, txHash });
}

/**
 * Baris delivered milik satu payer — punggung endpoint kepemilikan.
 * Hanya 'delivered' yang dihitung sebagai memiliki: 'pending' belum tentu
 * dibayar, dan 'settled_but_undelivered' adalah kasus pemulihan manual yang
 * tidak boleh diselesaikan diam-diam lewat jalur baca ini.
 */
export function listDeliveredUnlocks(db: Database, payer: string): UnlockRow[] {
  return db
    .query<UnlockRow, { payer: string }>(
      `SELECT * FROM unlocks WHERE payer = $payer AND status = 'delivered'
       ORDER BY created_at, prompt_id`,
    )
    .all({ payer: payer.toLowerCase() });
}

/**
 * Bukti kepemilikan satu prompt: baris delivered pertama untuk
 * (payer, prompt). Bisa ada lebih dari satu — pembelian ganda adalah
 * persis cacat yang endpoint kepemilikan tutup — baris TERTUA yang
 * dikembalikan karena tx hash-nya adalah bukti pembelian orisinal.
 */
export function findDeliveredUnlock(
  db: Database,
  payer: string,
  promptId: string,
): UnlockRow | null {
  return (
    db
      .query<UnlockRow, { payer: string; promptId: string }>(
        `SELECT * FROM unlocks WHERE payer = $payer AND prompt_id = $promptId
         AND status = 'delivered' ORDER BY created_at LIMIT 1`,
      )
      .get({ payer: payer.toLowerCase(), promptId }) ?? null
  );
}

export function markSettledButUndelivered(
  db: Database,
  payer: string,
  paymentNonce: string,
  txHash: string,
): void {
  db.query(
    `UPDATE unlocks SET status = 'settled_but_undelivered', tx_hash = $txHash
     WHERE payer = $payer AND payment_nonce = $paymentNonce`,
  ).run({ payer: payer.toLowerCase(), paymentNonce, txHash });
}

// ---------------------------------------------------------------------------
// listings

export interface NewListing {
  id: string;
  title: string;
  category: string;
  teaser: string;
  media: string | null;
  mediaType: string;
  mediaStatus: string;
  poster: string | null;
  priceAtomic: string;
  tier: "free" | "paid";
  contentHash: string;
  creatorAddress: string;
  signature: string;
}

export interface ListingRow {
  id: string;
  title: string;
  category: string;
  teaser: string;
  media: string | null;
  media_type: string;
  media_status: string;
  poster: string | null;
  price_atomic: string;
  tier: "free" | "paid";
  content_hash: string;
  creator_address: string;
  signature: string;
  onchain_tx_hash: string | null;
  created_at: string;
}

/**
 * A listing row rendered as the ONLY shape a public route may serve. The
 * parse at the end is the same mechanical no-body guarantee the seed
 * catalog gets from `listPublicEntries()`: `PublicCatalogEntrySchema` has
 * no field that can carry prompt text and strips unknown keys, so a
 * listing cannot leak its body through the catalog routes even by accident.
 */
export function listingToPublicEntry(row: ListingRow): PublicCatalogEntry {
  return PublicCatalogEntrySchema.parse({
    id: row.id,
    title: row.title,
    category: row.category,
    teaser: row.teaser,
    media: row.media,
    mediaType: row.media_type,
    mediaStatus: row.media_status,
    poster: row.poster,
    priceAtomic: row.price_atomic,
    tier: row.tier,
    contentHash: row.content_hash,
    attribution: {
      source: `creator:${row.creator_address}`,
      capturedAt: row.created_at,
      // R24: the catalog itself states the preview is the prompt's output.
      note: `Listed by ${row.creator_address}. Preview generated by running this prompt.`,
    },
  });
}

/**
 * Validates the would-be public entry BEFORE writing, so an invalid listing
 * (bad slug, malformed price, third-party media URL, …) can never enter the
 * table and break the catalog routes later.
 */
export function insertListing(db: Database, listing: NewListing): void {
  const createdAt = new Date().toISOString();
  const row: ListingRow = {
    id: listing.id,
    title: listing.title,
    category: listing.category,
    teaser: listing.teaser,
    media: listing.media,
    media_type: listing.mediaType,
    media_status: listing.mediaStatus,
    poster: listing.poster,
    price_atomic: listing.priceAtomic,
    tier: listing.tier,
    content_hash: listing.contentHash,
    creator_address: listing.creatorAddress,
    signature: listing.signature,
    onchain_tx_hash: null,
    created_at: createdAt,
  };
  listingToPublicEntry(row);
  db.query(
    `INSERT INTO listings (
       id, title, category, teaser, media, media_type, media_status, poster,
       price_atomic, tier, content_hash, creator_address, signature, created_at
     ) VALUES (
       $id, $title, $category, $teaser, $media, $media_type, $media_status, $poster,
       $price_atomic, $tier, $content_hash, $creator_address, $signature, $created_at
     )`,
  ).run({
    id: row.id,
    title: row.title,
    category: row.category,
    teaser: row.teaser,
    media: row.media,
    media_type: row.media_type,
    media_status: row.media_status,
    poster: row.poster,
    price_atomic: row.price_atomic,
    tier: row.tier,
    content_hash: row.content_hash,
    creator_address: row.creator_address,
    signature: row.signature,
    created_at: row.created_at,
  });
}

/**
 * Deteksi duplikat U7: badan yang identik menurut aturan hash terpublikasi
 * berarti listing yang sama. Constraint UNIQUE pada content_hash tetap
 * penjaga terakhirnya; helper ini ada supaya route bisa menjawab 409 yang
 * menyebut listing yang sudah ada, bukan error constraint mentah.
 */
export function findListingByContentHash(
  db: Database,
  contentHash: string,
): ListingRow | null {
  return (
    db
      .query<ListingRow, { contentHash: string }>(
        `SELECT * FROM listings WHERE content_hash = $contentHash`,
      )
      .get({ contentHash }) ?? null
  );
}

export function getListing(db: Database, id: string): ListingRow | null {
  return (
    db
      .query<ListingRow, { id: string }>(`SELECT * FROM listings WHERE id = $id`)
      .get({ id }) ?? null
  );
}

export function listListings(db: Database): ListingRow[] {
  return db
    .query<ListingRow, []>(`SELECT * FROM listings ORDER BY created_at, id`)
    .all();
}
