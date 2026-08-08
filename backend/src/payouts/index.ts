import type { Database } from "bun:sqlite";

import { feeBpsFromEnv, formatFeeBps } from "./fee";
import { PayoutPreflightError, preflight, type PayoutChain } from "./chain";
import {
  enqueuePayouts,
  flagInterruptedSends,
  listPayouts,
  markFlagged,
  markSending,
  markSent,
  pendingNetTotal,
  type PayoutRow,
} from "./queue";

/**
 * The creator payout worker.
 *
 * x402 settles one EIP-3009 transfer to one recipient, so the treasury takes
 * the gross and forwards the creator's share here. Structurally asynchronous,
 * exactly like the settler: a buyer never waits on it, and a chain outage
 * leaves rows owed rather than unlocks broken.
 *
 * Ordering per payout, and it does not commute:
 *
 *   mark `sending` (committed)  →  broadcast  →  confirm  →  mark `sent`
 *
 * The mark lands before the broadcast so that a crash leaves a row that
 * accuses itself. Marking after would leave a `pending` row indistinguishable
 * from one never attempted, and the next scan would pay it again.
 */

export interface PayoutRunResult {
  enqueued: number;
  sent: number;
  flagged: number;
  /** Rows found stranded in `sending` at startup, needing a human. */
  stranded: PayoutRow[];
}

export interface PayoutRunDeps {
  db: Database;
  chain: PayoutChain;
  /** The address buyers were told to pay; must match the treasury key. */
  payTo: string;
  feeBps?: bigint;
  minEthWei?: bigint;
  log?: (message: string) => void;
}

export async function runPayouts(deps: PayoutRunDeps): Promise<PayoutRunResult> {
  const { db, chain, payTo } = deps;
  const log = deps.log ?? ((message: string) => console.log(`[payouts] ${message}`));
  const feeBps = deps.feeBps ?? feeBpsFromEnv();

  // Before anything else: a previous process may have died mid-broadcast.
  // Those rows must never re-enter the drain.
  const stranded = flagInterruptedSends(db);
  for (const row of stranded) {
    log(
      `FLAGGED ${row.promptId} → ${row.creatorAddress}: a previous run was interrupted after ` +
        `marking this payout for broadcast. Check ${chain.treasuryAddress} on the explorer ` +
        `before releasing ${row.netAtomic} atomic USDC manually.`,
    );
  }

  const enqueued = enqueuePayouts(db, feeBps);
  if (enqueued > 0) log(`${enqueued} new payout(s) owed at ${formatFeeBps(feeBps)} fee`);

  const owed = listPayouts(db, "pending");
  if (owed.length === 0) return { enqueued, sent: 0, flagged: 0, stranded };

  try {
    await preflight({ chain, payTo, owedAtomic: pendingNetTotal(db), minEthWei: deps.minEthWei });
  } catch (error) {
    // A preflight failure is a configuration or funding problem, not a
    // per-payout one. Leave every row pending so a fixed environment drains
    // them untouched; flagging here would need a human for a machine problem.
    if (error instanceof PayoutPreflightError) {
      log(`refusing to run: ${error.message}`);
      return { enqueued, sent: 0, flagged: 0, stranded };
    }
    throw error;
  }

  let sent = 0;
  let flagged = 0;
  for (const row of owed) {
    markSending(db, row.payer, row.paymentNonce);
    try {
      const txHash = await chain.sendUsdc(row.creatorAddress, BigInt(row.netAtomic));
      const ok = await chain.confirm(txHash);
      if (!ok) {
        markFlagged(db, row.payer, row.paymentNonce, `payout transaction ${txHash} reverted`);
        flagged += 1;
        log(`FLAGGED ${row.promptId}: transfer ${txHash} reverted on-chain`);
        continue;
      }
      markSent(db, row.payer, row.paymentNonce, txHash);
      sent += 1;
      log(`paid ${row.creatorAddress} ${row.netAtomic} atomic USDC for ${row.promptId} (${txHash})`);
    } catch (error) {
      // The row stays `sending`: the broadcast may have landed even though the
      // call threw (a dropped connection after the node accepted it looks
      // exactly like a refusal). Flagging is the honest state — the next run
      // will not retry it, and a person checks the explorer.
      const reason = error instanceof Error ? error.message : String(error);
      markFlagged(db, row.payer, row.paymentNonce, `send failed, outcome unknown: ${reason}`);
      flagged += 1;
      log(`FLAGGED ${row.promptId}: ${reason}`);
    }
  }

  return { enqueued, sent, flagged, stranded };
}
