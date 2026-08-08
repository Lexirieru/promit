import type { Database } from "bun:sqlite";
import { Hono } from "hono";

import { feeBpsFromEnv, formatFeeBps, splitPayout } from "../payouts/fee.ts";
import { ensurePayoutSchema } from "../payouts/queue.ts";

/**
 * GET /v1/creators/:address — what a creator has listed, who bought it, and
 * what they have earned.
 *
 * Creators were blind to their own sales: the numbers existed in `unlocks` and
 * `payouts` but nothing read them back. This is the read path the dashboard
 * needs, and the one a creator needs before claiming anything.
 *
 * Unsigned, on the same reasoning as `GET /v1/unlocks`: every field here is
 * already public on-chain. The settlement transfers are visible on Basescan
 * with both addresses and amounts, so a signature would guard nothing while
 * making the dashboard impossible to open without a wallet. Prompt TEXT still
 * only leaves through `/v1/prompts/:id` behind a verified proof.
 *
 * Earnings are derived from DELIVERED unlocks only. A `pending` unlock may
 * never have settled, and `settled_but_undelivered` is an open incident —
 * counting either would show a creator money that does not exist.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface ListingEarnings {
  id: string;
  title: string;
  category: string;
  priceAtomic: string;
  tier: string;
  media: string | null;
  mediaType: string;
  poster: string | null;
  /** Distinct wallets that bought it. */
  buyers: number;
  /** Delivered unlocks; a wallet buying twice counts twice here. */
  sales: number;
  grossAtomic: string;
  feeAtomic: string;
  netAtomic: string;
  /** Already sent to the creator. */
  paidAtomic: string;
  /** Earned but not yet released. */
  claimableAtomic: string;
}

export function creatorRoutes(deps: { db: Database }) {
  const routes = new Hono();

  routes.get("/:address", (c) => {
    const address = c.req.param("address");
    if (!ADDRESS_RE.test(address)) {
      return c.json(
        {
          error: "invalid_address",
          message: "Pass a 0x-prefixed EVM address to read a creator's listings.",
        },
        400,
      );
    }

    ensurePayoutSchema(deps.db);
    const feeBps = feeBpsFromEnv();

    const rows = deps.db
      .query<
        {
          id: string;
          title: string;
          category: string;
          price_atomic: string;
          tier: string;
          media: string | null;
          media_type: string;
          poster: string | null;
          buyers: number;
          sales: number;
          gross: string | null;
        },
        [string]
      >(
        // LEFT JOIN so a listing with no sales still appears — a creator who
        // sees nothing should learn "nobody bought yet", not "nothing listed".
        `SELECT l.id, l.title, l.category, l.price_atomic, l.tier, l.media,
                l.media_type, l.poster,
                COUNT(DISTINCT u.payer)                       AS buyers,
                COUNT(u.payment_nonce)                        AS sales,
                COALESCE(SUM(CAST(u.amount_atomic AS INTEGER)), 0) AS gross
           FROM listings l
           LEFT JOIN unlocks u
             ON u.prompt_id = l.id AND u.status = 'delivered'
          WHERE LOWER(l.creator_address) = ?
          GROUP BY l.id
          ORDER BY l.created_at DESC`,
      )
      .all(address.toLowerCase());

    // Released amounts come from the payout table, not from the fee formula:
    // what was actually sent is a fact, and recomputing it would silently
    // disagree with reality the first time the rate changes.
    const paidByPrompt = new Map<string, bigint>();
    for (const row of deps.db
      .query<{ prompt_id: string; net_atomic: string }, [string]>(
        `SELECT p.prompt_id, p.net_atomic
           FROM payouts p
           JOIN listings l ON l.id = p.prompt_id
          WHERE p.status = 'sent' AND LOWER(l.creator_address) = ?`,
      )
      .all(address.toLowerCase())) {
      paidByPrompt.set(
        row.prompt_id,
        (paidByPrompt.get(row.prompt_id) ?? 0n) + BigInt(row.net_atomic),
      );
    }

    const listings: ListingEarnings[] = rows.map((row) => {
      const split = splitPayout(BigInt(row.gross ?? "0"), feeBps);
      const paid = paidByPrompt.get(row.id) ?? 0n;
      // Clamped at zero: a rate changed after a payout could otherwise render
      // a negative claimable, which reads like a debt the creator owes us.
      const claimable = split.netAtomic > paid ? split.netAtomic - paid : 0n;
      return {
        id: row.id,
        title: row.title,
        category: row.category,
        priceAtomic: row.price_atomic,
        tier: row.tier,
        media: row.media,
        mediaType: row.media_type,
        poster: row.poster,
        buyers: row.buyers,
        sales: row.sales,
        grossAtomic: split.grossAtomic.toString(),
        feeAtomic: split.feeAtomic.toString(),
        netAtomic: split.netAtomic.toString(),
        paidAtomic: paid.toString(),
        claimableAtomic: claimable.toString(),
      };
    });

    const sum = (pick: (l: ListingEarnings) => string) =>
      listings.reduce((total, listing) => total + BigInt(pick(listing)), 0n).toString();

    return c.json({
      creator: address.toLowerCase(),
      feeBps: Number(feeBps),
      feeLabel: formatFeeBps(feeBps),
      totals: {
        listings: listings.length,
        sales: listings.reduce((n, l) => n + l.sales, 0),
        // Summed per listing: the same wallet buying two different prompts is
        // two buyer relationships, and a creator reads this as "how many
        // purchases came in", not "how many humans do I have".
        buyers: listings.reduce((n, l) => n + l.buyers, 0),
        grossAtomic: sum((l) => l.grossAtomic),
        feeAtomic: sum((l) => l.feeAtomic),
        netAtomic: sum((l) => l.netAtomic),
        paidAtomic: sum((l) => l.paidAtomic),
        claimableAtomic: sum((l) => l.claimableAtomic),
      },
      listings,
    });
  });

  return routes;
}
