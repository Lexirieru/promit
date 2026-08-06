import type { Database } from "bun:sqlite";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type {
  FacilitatorClient,
  HTTPRequestContext,
  RoutesConfig,
} from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { BASE_SEPOLIA_NETWORK } from "@promit/x402-client";
import type { CatalogFile } from "../catalog/index.ts";
import { markSettledButUndelivered } from "../db.ts";
import { resolveUnionEntry, unlockPrice } from "./pricing.ts";

/**
 * x402 v2 resource-server wiring for the unlock route (U4), written against
 * the facilitator contract OBSERVED in docs/ARCHITECTURE.md §12, not against
 * package documentation. The library already normalizes the facilitator's
 * three HTTP classes (§12): 200-with-refusal becomes a result object,
 * 400/500-with-JSON becomes a thrown VerifyError/SettleError that
 * processHTTPRequest/processSettlement turn into a clean 402 for our client.
 */

/** §12/KTD2: the README's facilitator.x402.org is NXDOMAIN. */
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

export function resolveFacilitatorUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL;
}

/**
 * Path pattern the payment server protects. Free-tier entries and unknown
 * ids never reach processHTTPRequest — the route handler answers them first —
 * so everything that arrives here is a paid prompt.
 */
export const UNLOCK_ROUTE_PATTERN = "GET /v1/prompts/*";

export function promptIdFromPath(path: string): string {
  const segment = path.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface ExactEvmAuthorization {
  /** Signer address. Trustworthy only AFTER a successful verify/settle (§12). */
  from: string;
  /** ERC-3009 bytes32 nonce — one half of the (payer, nonce) unlock key (R19). */
  nonce: string;
}

/**
 * Extracts the ERC-3009 authorization out of an exact-EVM payment payload.
 * Returns null for anything malformed so callers can refuse BEFORE
 * settlement — a payload we cannot key an unlock row on must never be
 * allowed to move money.
 */
export function authorizationOf(payload: unknown): ExactEvmAuthorization | null {
  if (typeof payload !== "object" || payload === null) return null;
  const authorization = (payload as Record<string, unknown>).authorization;
  if (typeof authorization !== "object" || authorization === null) return null;
  const { from, nonce } = authorization as Record<string, unknown>;
  if (typeof from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(from)) return null;
  if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  return { from, nonce };
}

export interface UnlockPaymentDeps {
  catalog: CatalogFile;
  db: Database;
  /** Plain wallet, never the registry proxy (KTD3). */
  payTo: string;
  /** Injectable for tests; defaults to HTTP against FACILITATOR_URL (KTD21). */
  facilitator?: FacilitatorClient;
}

export interface UnlockPaymentServer {
  httpServer: x402HTTPResourceServer;
  /**
   * Memoized httpServer.initialize() (fetches /supported from the
   * facilitator). A failure clears the memo so one facilitator blip does not
   * wedge the route until restart.
   */
  ensureInitialized: () => Promise<void>;
}

export function createUnlockPaymentServer(deps: UnlockPaymentDeps): UnlockPaymentServer {
  const { catalog, db, payTo } = deps;
  const facilitator =
    deps.facilitator ??
    // Default 30 s timeout satisfies §12's "≥10 s for /settle, it waits for
    // tx inclusion". On a settle timeout the outcome is indeterminate and the
    // route reports it as such — never as a clean failure.
    new HTTPFacilitatorClient({ url: resolveFacilitatorUrl() });

  const resourceServer = new x402ResourceServer(facilitator);
  registerExactEvmScheme(resourceServer, { networks: [BASE_SEPOLIA_NETWORK] });

  // The safety net the plan mandates: the moment settlement succeeds, the
  // buyer's row flips to settled_but_undelivered — money has moved and no
  // body has gone out yet. The route flips it to 'delivered' only after the
  // response body is on its way. Any failure in between leaves a row that
  // names the payer, nonce, and tx hash instead of a charged buyer with no
  // trace. The UPDATE relies on the route's ordering rule (pending row is
  // written BEFORE settlement is invoked), so the row always exists here.
  resourceServer.onAfterSettle(async (context) => {
    const { result } = context;
    // afterSettle hooks also run for facilitator refusals (success:false) —
    // settle.success plus a tx hash is the ONLY unlock signal.
    if (!result.success || !result.transaction) return;
    const auth = authorizationOf(context.paymentPayload.payload);
    if (!auth) return;
    markSettledButUndelivered(db, auth.from, auth.nonce, result.transaction);
  });

  const routes: RoutesConfig = {
    [UNLOCK_ROUTE_PATTERN]: {
      accepts: {
        scheme: "exact",
        network: BASE_SEPOLIA_NETWORK,
        payTo,
        // Function-valued price (R8, v2-only): resolved per request from the
        // seed+listing union, so two prompts produce two different amounts
        // from this single route config.
        price: (context: HTTPRequestContext) => {
          const id = promptIdFromPath(context.path);
          const entry = resolveUnionEntry(catalog, db, id);
          if (!entry) {
            // Unreachable when the route handler runs first (it 404s unknown
            // ids before demanding payment); kept as a loud failure so a
            // wiring mistake cannot price an unknown prompt at a default.
            throw new Error(`no catalog entry for prompt id "${id}"`);
          }
          return unlockPrice(entry);
        },
        maxTimeoutSeconds: 300,
      },
      description: "Promit prompt unlock: full prompt text for a one-time USDC payment.",
      mimeType: "application/json",
      // AE1: the unpaid 402 body must carry no prompt text. It names the
      // price and denomination for humans; machines read the
      // PAYMENT-REQUIRED header.
      unpaidResponseBody: (context: HTTPRequestContext) => {
        const id = promptIdFromPath(context.path);
        const entry = resolveUnionEntry(catalog, db, id);
        return {
          contentType: "application/json",
          body: {
            error: "payment_required",
            message:
              `Unlocking "${id}" costs ${entry?.priceAtomic ?? "?"} atomic USDC on ` +
              `${BASE_SEPOLIA_NETWORK}. Retry with an x402 PAYMENT-SIGNATURE header; ` +
              `the PAYMENT-REQUIRED header on this response carries the requirements.`,
            id,
            priceAtomic: entry?.priceAtomic ?? null,
            asset: entry ? unlockPrice(entry).asset : null,
            network: BASE_SEPOLIA_NETWORK,
          },
        };
      },
      // R10: a payment that verifies but fails to settle does not unlock.
      // §12: the facilitator's reason label LIES for broken signatures
      // (everything that reverts simulation is labelled insufficient_balance)
      // and its errorMessage leaks internals — so the label ships with a
      // hedge and the message stays server-side (the route logs it).
      settlementFailedResponseBody: (_context, settleResult) => ({
        contentType: "application/json",
        body: {
          error: "settlement_failed",
          message:
            `Payment did not settle (facilitator reason label: ` +
            `"${settleResult.errorReason}" — the label can be misleading, e.g. a ` +
            `malformed signature is also reported as insufficient balance). ` +
            `The prompt was not unlocked and no USDC moved.`,
        },
      }),
    },
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  let initPromise: Promise<void> | null = null;
  const ensureInitialized = () => {
    initPromise ??= httpServer.initialize().catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  };

  return { httpServer, ensureInitialized };
}
