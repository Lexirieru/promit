import { cors } from "hono/cors";

/**
 * x402 v2 payment headers (KTD1). Browsers only let JavaScript read a
 * cross-origin response header if the server lists it in
 * `Access-Control-Expose-Headers` — everything else is silently null even
 * though DevTools shows it on the wire. Without exposing PAYMENT-REQUIRED
 * and PAYMENT-RESPONSE the browser client can read neither the payment
 * requirements nor the settlement tx hash, and the failure is confusing
 * because the request itself looks successful (plan U3).
 */
export const PAYMENT_EXPOSE_HEADERS = ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"];

/**
 * The client sends its signed payment here; preflight must allow it.
 * ENTITLEMENT-PROOF is the returning buyer's signed ownership proof — the
 * browser drops the header on a cross-origin request unless it is allowed,
 * and the failure mode is the buyer being charged again.
 */
export const PAYMENT_ALLOW_HEADERS = [
  "Content-Type",
  "PAYMENT-SIGNATURE",
  "ENTITLEMENT-PROOF",
];

/**
 * CORS for every route. Wide-open origin is deliberate: the catalog is a
 * public product surface (agents call it directly, KTD5) and payment
 * authorization lives in the x402 signature, not in the origin.
 */
export function paymentCors() {
  return cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: PAYMENT_ALLOW_HEADERS,
    exposeHeaders: PAYMENT_EXPOSE_HEADERS,
    maxAge: 86400,
  });
}
