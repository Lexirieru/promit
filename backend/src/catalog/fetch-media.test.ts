import { describe, expect, test } from "bun:test";

import { MediaFetchError, fetchRemoteMedia } from "./fetch-media.ts";

/**
 * A server that fetches a URL on request is an SSRF primitive. These tests are
 * the guard rail: every one of them describes a way to make Prom It read
 * something a creator could never legitimately point at.
 */

const ok = (body: Uint8Array | string, contentType = "video/mp4") =>
  new Response(body, { status: 200, headers: { "Content-Type": contentType } });

const redirect = (to: string) =>
  new Response(null, { status: 302, headers: { Location: to } });

const fetchOnce = (response: Response) => (async () => response) as typeof globalThis.fetch;

const options = (fetchImpl: typeof globalThis.fetch) => ({
  maxBytes: 1_000,
  fetchImpl,
  timeoutMs: 1_000,
});

describe("scheme and address guards", () => {
  test("refuses non-http schemes", async () => {
    // file: is how an SSRF becomes a local file read.
    for (const url of ["file:///etc/passwd", "data:video/mp4;base64,AAAA", "gopher://x/1"]) {
      await expect(
        fetchRemoteMedia(url, options(fetchOnce(ok("x")))),
      ).rejects.toMatchObject({ code: "blocked_scheme" });
    }
  });

  test("refuses loopback, private, and link-local addresses", async () => {
    // 169.254.169.254 is the cloud metadata endpoint: credentials live there.
    const blocked = [
      "http://127.0.0.1/preview.mp4",
      "http://localhost/preview.mp4",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/x.mp4",
      "http://172.16.4.4/x.mp4",
      "http://192.168.1.10/x.mp4",
      "http://100.100.0.1/x.mp4",
      "http://0.0.0.0/x.mp4",
      "http://[::1]/x.mp4",
    ];
    for (const url of blocked) {
      await expect(
        fetchRemoteMedia(url, options(fetchOnce(ok("x")))),
      ).rejects.toMatchObject({ code: "blocked_host" });
    }
  });

  test("refuses an IPv4-mapped IPv6 loopback", async () => {
    // ::ffff:127.0.0.1 is loopback wearing a different notation.
    await expect(
      fetchRemoteMedia("http://[::ffff:127.0.0.1]/x.mp4", options(fetchOnce(ok("x")))),
    ).rejects.toMatchObject({ code: "blocked_host" });
  });

  test("a malformed URL is refused before any request", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return ok("x");
    }) as typeof globalThis.fetch;

    await expect(fetchRemoteMedia("not a url", options(spy))).rejects.toMatchObject({
      code: "invalid_url",
    });
    expect(called).toBe(false);
  });
});

describe("redirects", () => {
  test("a redirect to a private address is refused, not followed", async () => {
    // The whole reason redirects are followed manually: a public first hop
    // bouncing to metadata would pass a check done only on the original host.
    const impl = (async (input: URL | string) =>
      String(input).includes("169.254")
        ? ok("secret")
        : redirect("http://169.254.169.254/latest/meta-data/")) as typeof globalThis.fetch;

    await expect(
      fetchRemoteMedia("http://8.8.8.8/preview.mp4", options(impl)),
    ).rejects.toMatchObject({ code: "blocked_host" });
  });

  test("gives up rather than following a redirect loop forever", async () => {
    const impl = (async () => redirect("http://8.8.8.8/again")) as typeof globalThis.fetch;

    await expect(
      fetchRemoteMedia("http://8.8.8.8/start", { ...options(impl), maxRedirects: 2 }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  test("follows a redirect between public hosts", async () => {
    let hops = 0;
    const impl = (async () => {
      hops += 1;
      return hops === 1 ? redirect("http://1.1.1.1/final.mp4") : ok(new Uint8Array([1, 2, 3]));
    }) as typeof globalThis.fetch;

    const result = await fetchRemoteMedia("http://8.8.8.8/start", options(impl));

    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("size cap", () => {
  test("stops reading once the cap is passed, whatever Content-Length claims", async () => {
    // The header is written by the server being guarded against, so a small
    // lie must not become unbounded memory.
    const big = new Uint8Array(5_000);
    const impl = fetchOnce(
      new Response(big, {
        status: 200,
        headers: { "Content-Type": "video/mp4", "Content-Length": "10" },
      }),
    );

    await expect(
      fetchRemoteMedia("http://8.8.8.8/big.mp4", options(impl)),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  test("accepts a body at the cap", async () => {
    const exact = new Uint8Array(1_000).fill(7);

    const result = await fetchRemoteMedia("http://8.8.8.8/x.mp4", options(fetchOnce(ok(exact))));

    expect(result.bytes.byteLength).toBe(1_000);
  });

  test("an empty body is refused instead of stored as a zero-byte preview", async () => {
    await expect(
      fetchRemoteMedia("http://8.8.8.8/x.mp4", options(fetchOnce(ok(new Uint8Array(0))))),
    ).rejects.toMatchObject({ code: "empty" });
  });
});

describe("failures", () => {
  test("a non-OK status is reported as unreachable", async () => {
    await expect(
      fetchRemoteMedia(
        "http://8.8.8.8/missing.mp4",
        options(fetchOnce(new Response("nope", { status: 404 }))),
      ),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  test("a thrown transport error surfaces as a typed refusal", async () => {
    const impl = (async () => {
      throw new Error("connection reset");
    }) as typeof globalThis.fetch;

    await expect(fetchRemoteMedia("http://8.8.8.8/x.mp4", options(impl))).rejects.toBeInstanceOf(
      MediaFetchError,
    );
  });

  test("returns the declared content type for the caller to validate", async () => {
    // Declared, never trusted: the listing route still checks magic bytes.
    const result = await fetchRemoteMedia(
      "http://8.8.8.8/x.mp4",
      options(fetchOnce(ok(new Uint8Array([9]), "image/webp"))),
    );

    expect(result.contentType).toBe("image/webp");
  });
});
