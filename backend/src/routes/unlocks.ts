import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { listDeliveredUnlocks } from "../db.ts";

/**
 * GET /v1/unlocks?payer=0x… — prompt yang sudah dibuka satu wallet, dari
 * tabel unlocks yang selama ini tidak diekspos siapa pun (celah produk:
 * pembeli yang kembali ditagih lagi karena tidak ada cara bertanya "apa
 * yang sudah saya miliki?").
 *
 * Daftar ini sengaja TANPA tanda tangan: setiap field yang keluar (prompt
 * id, waktu, tx hash, content hash) sudah publik di settlement on-chain
 * yang tx hash-nya kami tautkan sendiri di UI. Yang dijaga tanda tangan
 * adalah TEKS prompt, dan teks hanya keluar lewat /v1/prompts/:id dengan
 * bukti entitlement terverifikasi — daftar ini tidak pernah membawa teks.
 */

const PAYER_RE = /^0x[0-9a-fA-F]{40}$/;

export function unlocksRoutes(deps: { db: Database }) {
  const routes = new Hono();

  routes.get("/", (c) => {
    const payer = c.req.query("payer");
    if (!payer || !PAYER_RE.test(payer)) {
      return c.json(
        {
          error: "invalid_payer",
          message: "Pass ?payer=<0x-prefixed EVM address> to list a wallet's unlocks.",
        },
        400,
      );
    }
    const unlocks = listDeliveredUnlocks(deps.db, payer).map((row) => ({
      id: row.prompt_id,
      unlockedAt: row.created_at,
      txHash: row.tx_hash,
      contentHash: row.content_hash,
    }));
    return c.json({ payer: payer.toLowerCase(), unlocks, total: unlocks.length });
  });

  return routes;
}
