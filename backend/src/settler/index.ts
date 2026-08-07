import type { Database } from "bun:sqlite";
import { parseEther } from "viem";
import type { Hex } from "viem";
import { getListing, getUnlock, openDb } from "../db.ts";
import {
  DEFAULT_ADMIN_ROLE,
  SETTLER_ROLE,
  UPGRADER_ROLE,
  contentHashToBytes32,
  createRegistryChain,
  type RegistryChain,
} from "./chain.ts";
import {
  dueJobs,
  enqueueScan,
  ensureSettlerTables,
  getOnchainListing,
  markJobDone,
  markJobFlagged,
  markJobRetry,
  parseUnlockRef,
  putOnchainListing,
  recordReceiptMiss,
  setListingOnchainTxHash,
  setUnlockOnchainTxHash,
  type JobRow,
} from "./queue.ts";

/**
 * The settler worker (U10): drains settled unlocks and new listings from
 * SQLite onto PromitRegistry. Recording is asynchronous by construction —
 * the request paths only write DB rows, so a buyer never waits on a Base
 * Sepolia confirmation and a dead chain leaves unlocks served and jobs
 * pending, never a failed purchase.
 *
 * The three rules this file exists to enforce:
 *
 * 1. Idempotency comes from the KEY STORED IN THE REGISTRY, not from
 *    EIP-3009: the settler reads `isUnlocked(payer, nonce)` BEFORE sending,
 *    so a retry after a crash sends zero transactions instead of a real tx
 *    the contract silently no-ops (burning settler ETH). Listings get the
 *    same discipline via the ListingRegistered log scan, because
 *    registerListing has no on-chain duplicate guard at all.
 * 2. The facilitator's tx hash is CONFIRMED against a successful receipt
 *    before anything is written on-chain. A facilitator that reports success
 *    for a hash the chain never saw produces a Basescan link resolving to
 *    nothing; that job is flagged for a human, never recorded.
 * 3. Startup preflight refuses to run underfunded or mis-provisioned, with
 *    named errors. Purchases keep succeeding when this worker is down —
 *    that is the design — so a settler that cannot pay gas would otherwise
 *    fail invisibly.
 */

export class SettlerUnderfundedError extends Error {
  override readonly name = "SettlerUnderfundedError";
  constructor(balanceWei: bigint, minWei: bigint) {
    super(
      `settler ETH balance ${balanceWei} wei is below the ${minWei} wei threshold; ` +
        `refusing to start — unlocks would keep succeeding while recording silently stops. ` +
        `Fund the settler address or lower SETTLER_MIN_ETH deliberately.`,
    );
  }
}

export class SettlerRoleMissingError extends Error {
  override readonly name = "SettlerRoleMissingError";
  constructor(address: string) {
    super(
      `address ${address} does not hold SETTLER_ROLE on the registry; ` +
        `every write would revert. Grant the role (U9 runbook) or fix SETTLER_PRIVATE_KEY.`,
    );
  }
}

export class SettlerOverprivilegedError extends Error {
  override readonly name = "SettlerOverprivilegedError";
  constructor(address: string, role: string) {
    super(
      `settler address ${address} holds ${role}. The settler key must hold ONLY ` +
        `SETTLER_ROLE — a key that can upgrade the registry sitting in the backend ` +
        `environment defeats the role separation the registry's security model rests on.`,
    );
  }
}

export class SettlerConfigError extends Error {
  override readonly name = "SettlerConfigError";
}

export interface DrainReport {
  enqueued: number;
  processed: number;
  done: number;
  retried: number;
  flagged: number;
}

export interface SettlerDeps {
  db: Database;
  chain: RegistryChain;
  /** Injectable clock so backoff is testable without real waiting. */
  now?: () => Date;
  /** Refuse-to-start threshold; default 0.0005 ETH. */
  minBalanceWei?: bigint;
  /** First retry delay; doubles per attempt. */
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  /** Distinct null-receipt observations before a facilitator hash is flagged. */
  maxReceiptMisses?: number;
  pollIntervalMs?: number;
  metadataUriFor?: (promptId: string) => string;
}

export interface Settler {
  /** Throws one of the named Settler*Error classes; never starts silently broken. */
  preflight(): Promise<void>;
  /** One scan+process pass. Serialized: concurrent calls share a pass. */
  drain(): Promise<DrainReport>;
  /** Fire-and-forget poke from the request path (listings route). */
  notify(): void;
  start(): Promise<void>;
  stop(): void;
}

export const DEFAULT_MIN_BALANCE_WEI = parseEther("0.0005");
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 10 * 60_000;
const DEFAULT_MAX_RECEIPT_MISSES = 3;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

export function createSettler(deps: SettlerDeps): Settler {
  const { db, chain } = deps;
  const now = deps.now ?? (() => new Date());
  const minBalanceWei = deps.minBalanceWei ?? DEFAULT_MIN_BALANCE_WEI;
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxReceiptMisses = deps.maxReceiptMisses ?? DEFAULT_MAX_RECEIPT_MISSES;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // On-chain metadata must not leak prompt text (R2): the URI is an opaque
  // pointer into the catalog, never content.
  const metadataUriFor = deps.metadataUriFor ?? ((promptId: string) => `promit:prompt:${promptId}`);

  ensureSettlerTables(db);

  const backoffUntil = (attempts: number): string => {
    const delay = Math.min(backoffBaseMs * 2 ** Math.min(attempts, 10), maxBackoffMs);
    return new Date(now().getTime() + delay).toISOString();
  };

  const retry = (job: JobRow, report: DrainReport, reason: string): void => {
    markJobRetry(db, job.kind, job.ref, reason, backoffUntil(job.attempts));
    report.retried += 1;
  };
  const flag = (job: JobRow, report: DrainReport, reason: string): void => {
    markJobFlagged(db, job.kind, job.ref, reason);
    report.flagged += 1;
    console.error(`[settler] FLAGGED ${job.kind} ${job.ref.replaceAll("\n", " ")}: ${reason}`);
  };
  const done = (job: JobRow, report: DrainReport): void => {
    markJobDone(db, job.kind, job.ref);
    report.done += 1;
  };

  async function processRegisterListing(job: JobRow, report: DrainReport): Promise<void> {
    const listing = getListing(db, job.ref);
    if (!listing) {
      flag(job, report, `no listings row with id "${job.ref}"`);
      return;
    }
    const known = getOnchainListing(db, job.ref);
    if (known) {
      if (known.tx_hash && !listing.onchain_tx_hash) {
        setListingOnchainTxHash(db, job.ref, known.tx_hash);
      }
      done(job, report);
      return;
    }

    let contentHash: Hex;
    try {
      contentHash = contentHashToBytes32(listing.content_hash);
    } catch (error) {
      // Corrupt stored hash: no retry can fix it, so flag instead of loop.
      flag(job, report, (error as Error).message);
      return;
    }

    // Read-before-send: registerListing has no duplicate guard on-chain, so
    // a crash between our tx landing and the local write would otherwise
    // register the listing twice on retry.
    const existing = await chain.findListingByContentHash(contentHash);
    if (existing) {
      putOnchainListing(db, job.ref, existing.listingId, existing.txHash);
      if (existing.txHash) setListingOnchainTxHash(db, job.ref, existing.txHash);
      done(job, report);
      return;
    }

    const registered = await chain.registerListing({
      creator: listing.creator_address,
      contentHash,
      price: BigInt(listing.price_atomic),
      metadataURI: metadataUriFor(job.ref),
    });
    putOnchainListing(db, job.ref, registered.listingId, registered.txHash);
    setListingOnchainTxHash(db, job.ref, registered.txHash);
    done(job, report);
  }

  async function processRecordUnlock(job: JobRow, report: DrainReport): Promise<void> {
    const { payer, paymentNonce } = parseUnlockRef(job.ref);
    const unlock = getUnlock(db, payer, paymentNonce);
    if (!unlock) {
      flag(job, report, `no unlocks row for payer ${payer} nonce ${paymentNonce}`);
      return;
    }
    if (unlock.onchain_tx_hash) {
      done(job, report);
      return;
    }
    if (!unlock.tx_hash) {
      // Post-settlement rows always carry the facilitator hash; defensive.
      flag(job, report, "unlock row has no facilitator tx hash to confirm");
      return;
    }

    // Rule 2: confirm the facilitator's hash actually landed before the
    // registry ever hears about this unlock.
    const receipt = await chain.getTransactionReceipt(unlock.tx_hash);
    if (receipt === null) {
      const misses = recordReceiptMiss(db, job.kind, job.ref);
      if (misses >= maxReceiptMisses) {
        flag(
          job,
          report,
          `facilitator reported tx ${unlock.tx_hash} but the chain has no receipt for it ` +
            `after ${misses} checks — not recording an unlock no explorer can corroborate`,
        );
      } else {
        retry(job, report, `no receipt yet for facilitator tx ${unlock.tx_hash}`);
      }
      return;
    }
    if (receipt.status === "reverted") {
      flag(job, report, `facilitator tx ${unlock.tx_hash} reverted on-chain`);
      return;
    }

    const mapping = getOnchainListing(db, unlock.prompt_id);
    if (!mapping) {
      if (getListing(db, unlock.prompt_id)) {
        // Its register_listing job runs first in the same drain; landing
        // here means that job failed this pass — defer, don't lose.
        retry(job, report, `listing "${unlock.prompt_id}" is not registered on-chain yet`);
      } else {
        // Every seed entry is free (R3), so a settled unlock always points
        // at a creator listing; anything else is data corruption.
        flag(job, report, `prompt "${unlock.prompt_id}" has no listing row to register`);
      }
      return;
    }

    // Rule 1: the registry's stored key is the idempotency authority. A
    // retry that finds the key recorded sends NOTHING — the contract would
    // no-op the duplicate anyway, at the price of real gas.
    if (await chain.isUnlocked(payer, paymentNonce as Hex)) {
      done(job, report);
      return;
    }

    const { txHash } = await chain.recordUnlock({
      payer,
      nonce: paymentNonce as Hex,
      listingId: BigInt(mapping.listing_id),
      amount: BigInt(unlock.amount_atomic),
    });
    setUnlockOnchainTxHash(db, payer, paymentNonce, txHash);
    done(job, report);
  }

  async function drainOnce(): Promise<DrainReport> {
    const report: DrainReport = { enqueued: 0, processed: 0, done: 0, retried: 0, flagged: 0 };
    report.enqueued = enqueueScan(db);
    for (const job of dueJobs(db, now().toISOString())) {
      report.processed += 1;
      try {
        if (job.kind === "register_listing") {
          await processRegisterListing(job, report);
        } else {
          await processRecordUnlock(job, report);
        }
      } catch (error) {
        // Chain/RPC failure: the unlock stays served, the job stays pending.
        retry(job, report, (error as Error).message ?? String(error));
      }
    }
    return report;
  }

  let active: Promise<DrainReport> | null = null;
  let again = false;
  const drain = (): Promise<DrainReport> => {
    if (active) {
      // A poke during a pass means new work may have landed after the scan:
      // run one more pass before settling the shared promise.
      again = true;
      return active;
    }
    active = (async () => {
      let report = await drainOnce();
      while (again) {
        again = false;
        report = await drainOnce();
      }
      return report;
    })().finally(() => {
      active = null;
    });
    return active;
  };

  async function preflight(): Promise<void> {
    const balance = await chain.getEthBalance();
    if (balance < minBalanceWei) {
      throw new SettlerUnderfundedError(balance, minBalanceWei);
    }
    const address = chain.settlerAddress;
    if (!(await chain.hasRole(SETTLER_ROLE, address))) {
      throw new SettlerRoleMissingError(address);
    }
    if (await chain.hasRole(UPGRADER_ROLE, address)) {
      throw new SettlerOverprivilegedError(address, "UPGRADER_ROLE");
    }
    if (await chain.hasRole(DEFAULT_ADMIN_ROLE, address)) {
      throw new SettlerOverprivilegedError(address, "DEFAULT_ADMIN_ROLE");
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    preflight,
    drain,
    notify: () => {
      void drain().catch((error) => console.error(`[settler] drain failed:`, error));
    },
    async start() {
      await preflight();
      timer ??= setInterval(() => {
        void drain().catch((error) => console.error(`[settler] drain failed:`, error));
      }, pollIntervalMs);
      await drain();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * Standalone worker entry: `bun run settler` from backend/. Reads the same
 * SQLite file the API writes (WAL makes the cross-process read safe) so the
 * API's own process never carries chain latency.
 */
if (import.meta.main) {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const registryAddress = process.env.PROMIT_REGISTRY_ADDRESS;
  const settlerPrivateKey = process.env.SETTLER_PRIVATE_KEY;
  if (!registryAddress || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) {
    throw new SettlerConfigError(
      "PROMIT_REGISTRY_ADDRESS is not a 0x address; set it to the registry proxy (U9 runbook).",
    );
  }
  if (!settlerPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(settlerPrivateKey)) {
    throw new SettlerConfigError(
      "SETTLER_PRIVATE_KEY is not a 0x 32-byte key; the settler cannot sign registry writes.",
    );
  }
  const minEth = process.env.SETTLER_MIN_ETH;
  const deployBlock = process.env.PROMIT_REGISTRY_DEPLOY_BLOCK;
  const chain = createRegistryChain({
    rpcUrl,
    registryAddress,
    settlerPrivateKey: settlerPrivateKey as Hex,
    deployBlock: deployBlock ? BigInt(deployBlock) : undefined,
  });
  const settler = createSettler({
    db: openDb(),
    chain,
    minBalanceWei: minEth ? parseEther(minEth) : undefined,
  });
  await settler.start();
  console.log(
    `[settler] recording to ${registryAddress} as ${chain.settlerAddress} via ${rpcUrl}`,
  );
}
