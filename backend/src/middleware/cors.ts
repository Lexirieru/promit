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
  // `@x402/fetch` copies the 402 response's headers onto the retry request,
  // so the paid request arrives carrying ACCESS-CONTROL-EXPOSE-HEADERS — a
  // response header travelling as a request header. Nonsense on the wire, but
  // a browser still preflights it, and a name missing from this list makes the
  // browser drop the request before it is sent. The failure it reports is
  // "CORS error"/"Failed to fetch" with no response, which reads like a server
  // misconfiguration; curl and the CLI never see it because neither enforces
  // CORS. Allowing the name costs nothing — the server ignores it — and the
  // client strips it too (packages/x402-client/src/client.ts). Both sides,
  // because either alone leaves one client version broken.
  "ACCESS-CONTROL-EXPOSE-HEADERS",
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
