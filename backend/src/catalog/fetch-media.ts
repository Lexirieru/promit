import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetching preview media from a creator-supplied URL.
 *
 * Listing refuses third-party URLs in the catalog (R5): whoever owns a URL can
 * change what it points at after a buyer has already paid to see it. Mirroring
 * keeps that guarantee while letting a creator paste a link — the bytes become
 * ours at listing time, and the catalog never stores the foreign address.
 *
 * The download itself is trivial. The guards are the work: a server that
 * fetches an arbitrary URL on request is an SSRF primitive, and this one runs
 * inside a container that can reach a cloud metadata endpoint and any private
 * neighbour. Everything below exists to keep that reachable set empty.
 */

export class MediaFetchError extends Error {
  constructor(
    readonly code:
      | "invalid_url"
      | "blocked_scheme"
      | "blocked_host"
      | "too_many_redirects"
      | "unreachable"
      | "too_large"
      | "empty",
    message: string,
  ) {
    super(message);
    this.name = "MediaFetchError";
  }
}

/**
 * Address ranges a creator's preview can never legitimately live on. Blocking
 * by NAME is useless (any name can resolve anywhere), so the check is on the
 * resolved ADDRESS.
 */
function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    // Unique-local fc00::/7 and link-local fe80::/10.
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
    // IPv4-mapped addresses must be judged as the IPv4 they carry, in BOTH
    // notations: ::ffff:127.0.0.1 and its normalised hex form ::ffff:7f00:1.
    // Only checking the dotted spelling lets loopback through under the other.
    const dotted = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isBlockedAddress(dotted[1]!);
    const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1]!, 16);
      const low = parseInt(hex[2]!, 16);
      return isBlockedAddress(
        [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
      );
    }
    return false;
  }

  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Resolves the host and refuses anything that is not a public address.
 *
 * Known limit, stated rather than hidden: this resolves, checks, and then lets
 * `fetch` resolve again, so a DNS entry that changes between the two answers
 * (rebinding) is not caught. Closing that needs pinning the connection to the
 * checked address, which Bun's fetch does not expose. The remaining exposure
 * is one request to an internal address with a response the creator never
 * sees — the bytes are still validated as media before anything is stored.
 */
async function assertPublicHost(rawHostname: string): Promise<void> {
  // URL.hostname keeps the brackets on an IPv6 literal, and isIP rejects them,
  // which would send `[::1]` down the DNS path and fail as "unreachable"
  // instead of being recognised as loopback.
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true });
  } catch {
    throw new MediaFetchError("unreachable", `could not resolve ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new MediaFetchError("unreachable", `${hostname} resolved to no addresses`);
  }
  // EVERY address must be public: a name resolving to one public and one
  // private address would otherwise be a coin flip.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new MediaFetchError(
        "blocked_host",
        `${hostname} resolves to ${address}, which is not a public address`,
      );
    }
  }
}

export interface FetchMediaOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface FetchedMedia {
  bytes: Uint8Array;
  /** The server's declared type, still subject to magic-byte validation. */
  contentType: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Downloads media from a creator-supplied URL under every guard above.
 *
 * Redirects are followed MANUALLY so each hop is re-checked; letting fetch
 * follow them would let a public URL bounce to `169.254.169.254` with only the
 * first host ever inspected.
 */
export async function fetchRemoteMedia(
  rawUrl: string,
  options: FetchMediaOptions,
): Promise<FetchedMedia> {
  const {
    maxBytes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    fetchImpl = globalThis.fetch,
  } = options;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaFetchError("invalid_url", `${rawUrl} is not a URL`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        // file:, data:, gopher: and friends are how an SSRF becomes a file read.
        throw new MediaFetchError("blocked_scheme", `${url.protocol} URLs are not accepted`);
      }
      await assertPublicHost(url.hostname);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "image/*,video/*" },
        });
      } catch (error) {
        throw new MediaFetchError(
          "unreachable",
          `could not fetch ${url.host}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new MediaFetchError("unreachable", `${url.host} redirected without a location`);
        }
        url = new URL(location, url);
        continue;
      }

      if (!response.ok) {
        throw new MediaFetchError("unreachable", `${url.host} answered HTTP ${response.status}`);
      }

      const bytes = await readCapped(response, maxBytes);
      if (bytes.byteLength === 0) {
        throw new MediaFetchError("empty", `${url.host} returned an empty body`);
      }
      return { bytes, contentType: response.headers.get("content-type") ?? "" };
    }
    throw new MediaFetchError("too_many_redirects", `more than ${maxRedirects} redirects`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the body while counting, and stops the moment the cap is passed.
 *
 * Content-Length is not trusted: it is written by the same server being
 * guarded against, and a lying header is the cheapest way to turn a size limit
 * into unbounded memory.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MediaFetchError(
        "too_large",
        `the preview exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
