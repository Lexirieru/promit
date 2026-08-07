import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HonoAdapter } from "@x402/hono";
import type {
  FacilitatorClient,
  HTTPRequestContext,
  HTTPResponseInstructions,
} from "@x402/core/server";
import { BASE_SEPOLIA_NETWORK } from "@promit/x402-client";
import type { CatalogFile } from "../catalog/index.ts";
import { getFreePromptBody } from "../catalog/index.ts";
import {
  findDeliveredUnlock,
  getPaidBody,
  markUnlockDelivered,
  recordUnlock,
} from "../db.ts";
import { readEntitlementProof, verifyEntitlementProof } from "../entitlement.ts";
import {
  authorizationOf,
  createUnlockPaymentServer,
  type UnlockPaymentServer,
} from "../x402/server.ts";
import { resolveUnionEntry } from "../x402/pricing.ts";

/**
 * GET /v1/prompts/:id — the paid content path (U4), mounted at /v1/prompts.
 *
 * The one delivery path for prompt text (KTD6): free tier answers directly
 * from the catalog with no payment, paid tier answers only after the
 * facilitator settles. The money-path ordering rule is explicit here:
 *
 *   resolve body -> write 'pending' unlock row -> settle
 *   -> row flips to 'settled_but_undelivered' (onAfterSettle hook)
 *   -> deliver -> row flips to 'delivered'
 *
 * so at every instant after money moves there is a row naming the payer,
 * nonce, and tx hash. settle.success plus a tx hash is the ONLY unlock
 * signal (R10): a payload that passed verify can still fail settle.
 */

export interface DeliveredUnlock {
  payer: string;
  paymentNonce: string;
  txHash: string;
}

export interface UnlockRouteDeps {
  catalog: CatalogFile;
  db: Database;
  /** Receiving wallet; defaults to PAY_TO_ADDRESS. Never the proxy (KTD3). */
  payTo?: string;
  /** Injectable for tests; defaults to HTTP against FACILITATOR_URL. */
  facilitator?: FacilitatorClient;
  /**
   * The delivery-completion step, run only after settlement succeeded.
   * Defaults to marking the unlock row 'delivered'. Tests override it with a
   * throwing function to exercise the settled-but-undelivered path.
   */
  deliver?: (db: Database, unlock: DeliveredUnlock) => void;
}

function respondWithInstructions(c: Context, instructions: HTTPResponseInstructions) {
  for (const [name, value] of Object.entries(instructions.headers)) {
    c.header(name, value);
  }
  const status = instructions.status as ContentfulStatusCode;
  return instructions.isHtml
    ? c.html(String(instructions.body ?? ""), status)
    : c.json(instructions.body ?? {}, status);
}

export function unlockRoutes(deps: UnlockRouteDeps) {
  const { catalog, db } = deps;
  const payTo = deps.payTo ?? process.env.PAY_TO_ADDRESS;
  const deliver =
    deps.deliver ??
    ((database: Database, unlock: DeliveredUnlock) =>
      markUnlockDelivered(database, unlock.payer, unlock.paymentNonce, unlock.txHash));

  // Built lazily so free-tier and 404 traffic (and a deployment without
  // PAY_TO_ADDRESS) never construct a payment server or touch the facilitator.
  let paymentServer: UnlockPaymentServer | null = null;
  const getPaymentServer = () => {
    if (!payTo) return null;
    paymentServer ??= createUnlockPaymentServer({
      catalog,
      db,
      payTo,
      facilitator: deps.facilitator,
    });
    return paymentServer;
  };

  const routes = new Hono();

  routes.get("/:id", async (c) => {
    const id = c.req.param("id");
    const entry = resolveUnionEntry(catalog, db, id);

    // 404 before any payment is demanded — no PAYMENT-REQUIRED header here.
    if (!entry) {
      return c.json(
        { error: "unknown_prompt_id", message: `No prompt with id "${id}".` },
        404,
      );
    }

    // R3 carve-out: free tier returns full text with no payment, carrying
    // its attribution. Seed bodies live in the catalog file; a free creator
    // listing's body lives in the SQLite body store.
    if (entry.tier === "free") {
      const text = getFreePromptBody(catalog, id)?.body ?? getPaidBody(db, id);
      if (text === null) {
        return c.json(
          { error: "prompt_body_missing", message: `Prompt "${id}" has no stored text.` },
          500,
        );
      }
      return c.json({
        id,
        tier: "free",
        text,
        contentHash: entry.contentHash,
        attribution: entry.attribution,
      });
    }

    // Kepemilikan SEBELUM 402: pembeli yang kembali membuktikan — bukan
    // mengklaim — identitasnya dengan tanda tangan atas pesan yang menyebut
    // prompt INI, dan mendapat teksnya tanpa ditagih lagi. Bukti yang cacat
    // atau kedaluwarsa DITOLAK 401, tidak pernah diam-diam dijatuhkan ke
    // jalur tagih: klien yang berniat membuktikan kepemilikan tapi gagal
    // harus mendengarnya, bukan membayar dua kali. Bukti yang sah milik
    // wallet TANPA baris delivered jatuh ke 402 normal — wallet lain tetap
    // ditagih.
    const proof = readEntitlementProof({
      header: (name) => c.req.header(name),
      query: (name) => c.req.query(name),
    });
    if (proof) {
      const verdict = await verifyEntitlementProof(proof, id);
      if (!verdict.ok) {
        return c.json({ error: verdict.code, message: verdict.message }, 401);
      }
      const owned = findDeliveredUnlock(db, verdict.payer, id);
      if (owned) {
        const text = getPaidBody(db, id);
        if (text === null) {
          return c.json(
            { error: "prompt_body_missing", message: `Prompt "${id}" has no stored text.` },
            500,
          );
        }
        return c.json({
          id,
          tier: "paid",
          text,
          contentHash: entry.contentHash,
          txHash: owned.tx_hash,
          network: BASE_SEPOLIA_NETWORK,
          payer: verdict.payer,
          alreadyOwned: true,
          attribution: entry.attribution,
        });
      }
    }

    const server = getPaymentServer();
    if (!server) {
      // Refusing beats a default: a made-up payTo would demand signatures
      // that send USDC to an address nobody controls.
      return c.json(
        {
          error: "pay_to_unconfigured",
          message: "Paid unlocks are disabled: PAY_TO_ADDRESS is not configured.",
        },
        503,
      );
    }

    try {
      await server.ensureInitialized();
    } catch (error) {
      console.warn(`[unlock] facilitator initialization failed:`, error);
      return c.json(
        {
          error: "facilitator_unreachable",
          message: "The payment facilitator could not be reached. Try again shortly.",
        },
        502,
      );
    }

    const adapter = new HonoAdapter(c);
    const context: HTTPRequestContext = {
      adapter,
      path: c.req.path,
      method: c.req.method,
      paymentHeader: c.req.header("payment-signature") ?? c.req.header("x-payment"),
    };

    let processed;
    try {
      processed = await server.httpServer.processHTTPRequest(context);
    } catch (error) {
      // FacilitatorResponseError: malformed facilitator answer or timeout.
      console.warn(`[unlock] facilitator error during verification:`, error);
      return c.json(
        {
          error: "facilitator_error",
          message: "The payment facilitator returned an unusable response. No USDC moved.",
        },
        502,
      );
    }

    // 402 challenge, verify refusal, or facilitator 4xx/5xx normalized by the
    // library (§12: unknown scheme/network arrives as HTTP 500 and still ends
    // here as a clean 402 for our client).
    if (processed.type === "payment-error") {
      return respondWithInstructions(c, processed.response);
    }
    if (processed.type === "no-payment-required") {
      // Every paid prompt path matches UNLOCK_ROUTE_PATTERN; reaching this
      // arm means the route config drifted from the mount point.
      return c.json(
        { error: "unlock_route_misconfigured", message: "Payment routing is misconfigured." },
        500,
      );
    }

    const { cancellationDispatcher, paymentPayload, paymentRequirements, declaredExtensions } =
      processed;

    // After a SUCCESSFUL verify, authorization.from is the recovered signer
    // (§12 proved recovery); on failure responses it is an unverified echo,
    // but those never reach this point.
    const auth = authorizationOf(paymentPayload.payload);
    if (!auth) {
      await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 400 });
      return c.json(
        {
          error: "malformed_payment_payload",
          message: "The payment payload carries no usable ERC-3009 authorization. No USDC moved.",
        },
        400,
      );
    }

    // ORDERING RULE step 1: resolve the body BEFORE settlement is invoked.
    // A missing body is discovered while the buyer is still uncharged.
    const text = getPaidBody(db, id);
    if (text === null) {
      await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 500 });
      return c.json(
        {
          error: "prompt_body_missing",
          message: `Prompt "${id}" has no stored text; the payment was not settled and no USDC moved.`,
        },
        500,
      );
    }

    // ORDERING RULE step 2: write the unlock row BEFORE settlement. The PK
    // (payer, nonce) makes a replay one row, not two (R19); the
    // ON CONFLICT DO NOTHING insert keeps the original row on a retry.
    recordUnlock(db, {
      payer: auth.from,
      paymentNonce: auth.nonce,
      promptId: id,
      amountAtomic: paymentRequirements.amount,
      contentHash: entry.contentHash,
    });

    // ORDERING RULE step 3: settle. The onAfterSettle hook flips the row to
    // 'settled_but_undelivered' the moment the facilitator reports success.
    let settle;
    try {
      settle = await server.httpServer.processSettlement(
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
        { request: context },
      );
    } catch (error) {
      // A settle timeout is indeterminate: the facilitator may still have
      // settled (its own docs say so). The 'pending' row keeps the attempt
      // reconcilable; never report this as a clean failure.
      console.error(`[unlock] settlement outcome indeterminate for "${id}":`, error);
      return c.json(
        {
          error: "settlement_indeterminate",
          message:
            "The facilitator did not answer settlement; the payment may or may not have " +
            "settled. The attempt is recorded. Do not retry with a new payment until resolved.",
        },
        502,
      );
    }

    if (!settle.success) {
      // Verified but not settled -> no unlock, no text (R10). The row stays
      // 'pending' with no tx hash. §12: log the facilitator's errorMessage
      // for diagnosis but never forward it (it leaks simulation internals).
      console.warn(
        `[unlock] settle failed for "${id}": reason=${settle.errorReason}`,
        settle.errorMessage,
      );
      return respondWithInstructions(c, settle.response);
    }

    const txHash = settle.transaction;
    try {
      deliver(db, { payer: auth.from, paymentNonce: auth.nonce, txHash });
      for (const [name, value] of Object.entries(settle.headers)) {
        c.header(name, value);
      }
      return c.json({
        id,
        tier: "paid",
        text,
        contentHash: entry.contentHash,
        txHash,
        network: paymentRequirements.network,
        payer: settle.payer ?? auth.from,
        attribution: entry.attribution,
      });
    } catch (error) {
      // Money moved, body did not. The onAfterSettle hook already recorded
      // settled_but_undelivered; the error must name the tx hash so the
      // buyer holds proof of payment.
      console.error(`[unlock] settled but undelivered for "${id}" tx=${txHash}:`, error);
      return c.json(
        {
          error: "settled_but_undelivered",
          message:
            `Payment settled on-chain (transaction ${txHash}) but the prompt could not be ` +
            `delivered. The unlock is recorded against your payment; quote this transaction ` +
            `hash to recover it.`,
          txHash,
        },
        500,
      );
    }
  });

  return routes;
}
