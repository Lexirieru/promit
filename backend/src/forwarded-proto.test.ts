import { describe, expect, test } from "bun:test";
import { forwardedProtoFetch } from "./index.ts";

/**
 * Regression guard for the bug that made the browser Unlock button fail on
 * Railway while the CLI succeeded: the 402 payload advertised the resource as
 * http:// because TLS terminates at the proxy, and the browser client refused
 * the mismatch before ever asking the wallet to sign.
 */
describe("forwardedProtoFetch", () => {
  const seen = (req: Request) => new Response(req.url);

  test("upgrades the scheme when the proxy reports https", async () => {
    const res = await forwardedProtoFetch(seen)(
      new Request("http://api.example.com/v1/prompts/x", {
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(await res.text()).toBe("https://api.example.com/v1/prompts/x");
  });

  test("leaves the request alone without the header", async () => {
    const res = await forwardedProtoFetch(seen)(new Request("http://localhost:3001/health"));
    expect(await res.text()).toBe("http://localhost:3001/health");
  });

  test("never downgrades https on an attacker-set header", async () => {
    const res = await forwardedProtoFetch(seen)(
      new Request("https://api.example.com/health", {
        headers: { "x-forwarded-proto": "http" },
      }),
    );
    expect(await res.text()).toBe("https://api.example.com/health");
  });

  test("preserves method and headers", async () => {
    const echo = (req: Request) =>
      new Response(JSON.stringify({ m: req.method, h: req.headers.get("payment-signature") }));
    const res = await forwardedProtoFetch(echo)(
      new Request("http://api.example.com/v1/prompts/x", {
        method: "GET",
        headers: { "x-forwarded-proto": "https", "payment-signature": "sig123" },
      }),
    );
    expect(await res.json()).toEqual({ m: "GET", h: "sig123" });
  });
});
