import { describe, expect, test } from "bun:test";

import { createApp } from "../index";
import { PAYMENT_ALLOW_HEADERS, PAYMENT_EXPOSE_HEADERS } from "./cors";

/**
 * Regression pins for the browser-only unlock failure (2026-08-08).
 *
 * `@x402/fetch` carries the 402 response's headers onto the retry request, so
 * the paid request arrives with `Access-Control-Expose-Headers` on it — a
 * response header travelling as a request header. curl and the CLI never
 * notice because neither enforces CORS. A browser does: a request header name
 * absent from `Access-Control-Allow-Headers` makes it drop the request before
 * sending, which surfaces as "CORS error" / "Failed to fetch" with an empty
 * response and nothing at all in the server log.
 *
 * That is why the CLI could buy a prompt the browser could not, against the
 * same endpoint with the same signature. Measured directly from the deployed
 * frontend's origin: the request succeeded (402) without the header and threw
 * "Failed to fetch" with it. Remove the name below and paid unlock breaks in
 * every browser while every server-side test stays green.
 */
describe("CORS preflight allows the headers the x402 client actually sends", () => {
  const preflight = (requested: string) =>
    createApp().request("/v1/prompts/floating-navbar-hero", {
      method: "OPTIONS",
      headers: {
        Origin: "https://promit-two.vercel.app",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": requested,
      },
    });

  /** The browser requires every requested name to appear in the allow list. */
  const allowed = (response: Response): string[] =>
    (response.headers.get("Access-Control-Allow-Headers") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);

  test("allows ACCESS-CONTROL-EXPOSE-HEADERS, which @x402/fetch puts on the retry", async () => {
    const response = await preflight("payment-signature,access-control-expose-headers");

    expect(response.status).toBeLessThan(300);
    expect(allowed(response)).toContain("access-control-expose-headers");
  });

  test("allows the payment and entitlement headers alongside it", async () => {
    const response = await preflight("payment-signature,entitlement-proof,content-type");
    const names = allowed(response);

    for (const header of ["payment-signature", "entitlement-proof", "content-type"]) {
      expect(names).toContain(header);
    }
  });

  test("every allowed name is announced on the preflight response", async () => {
    const response = await preflight("payment-signature");
    const names = allowed(response);

    for (const header of PAYMENT_ALLOW_HEADERS) {
      expect(names).toContain(header.toLowerCase());
    }
  });

  test("still exposes the payment response headers to page JavaScript", async () => {
    const response = await createApp().request("/v1/catalog", {
      headers: { Origin: "https://promit-two.vercel.app" },
    });
    const exposed = (response.headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((name) => name.trim().toUpperCase());

    for (const header of PAYMENT_EXPOSE_HEADERS) {
      expect(exposed).toContain(header);
    }
  });
});
