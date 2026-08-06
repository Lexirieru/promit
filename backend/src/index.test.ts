import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { loadCatalogFile } from "./catalog/index.ts";
import { openDb } from "./db.ts";
import { createApp } from "./index.ts";

/**
 * App-level scenarios from plan U3: health, the payment-header CORS
 * contract, and media serving from Promit-owned storage (R5).
 */

let app: ReturnType<typeof createApp>;
let db: Database;

beforeAll(() => {
  db = openDb(":memory:");
  app = createApp({ catalog: loadCatalogFile(), db });
});

describe("GET /health", () => {
  test("returns 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("CORS payment headers", () => {
  test("preflight allows PAYMENT-SIGNATURE", async () => {
    const res = await app.request("/v1/catalog/some-id", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "PAYMENT-SIGNATURE",
      },
    });
    expect(res.status).toBe(204);
    const allowed = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowed.toUpperCase()).toContain("PAYMENT-SIGNATURE");
  });

  test("responses expose PAYMENT-REQUIRED and PAYMENT-RESPONSE to browser JS", async () => {
    const res = await app.request("/v1/catalog", {
      headers: { Origin: "http://localhost:3000" },
    });
    const exposed = (res.headers.get("Access-Control-Expose-Headers") ?? "").toUpperCase();
    // Without these, a browser sees a "successful" response whose payment
    // headers all read as null — the confusing failure the plan warns about.
    expect(exposed).toContain("PAYMENT-REQUIRED");
    expect(exposed).toContain("PAYMENT-RESPONSE");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("GET /media/*", () => {
  test("serves a mirrored file with a content type", async () => {
    // Committed by U2's mirror step; catalog media fields point at /media/<file>.
    const res = await app.request("/media/prompt.poster.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("rejects path traversal out of the media dir", async () => {
    const res = await app.request("/media/..%2Fdata%2Fcatalog.json");
    expect(res.status).toBe(404);
  });

  test("missing file is a 404 in the contract error shape", async () => {
    const res = await app.request("/media/nope.jpg");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("media_not_found");
  });
});
