import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { PublicCatalogEntry } from "@/lib/api";

/** Synthetic entries for behaviour tests: one free video, one free image, one paid video. */
export function makeEntry(overrides: Partial<PublicCatalogEntry> = {}): PublicCatalogEntry {
  return {
    id: "test-prompt",
    title: "Test Prompt",
    category: "Hero",
    teaser: "A teaser sentence.",
    media: "/media/test-prompt.mp4",
    mediaType: "video",
    mediaStatus: "mirrored",
    poster: "/media/test-prompt.poster.jpg",
    priceAtomic: "0",
    tier: "free",
    contentHash: `keccak256:${"ab".repeat(32)}`,
    attribution: {
      source: "motionsites.ai",
      capturedAt: "2026-08-06T00:00:00.000Z",
      note: "Seeded from the motionsites.ai free tier.",
    },
    ...overrides,
  };
}

export const freeVideoEntry = makeEntry();
export const freeImageEntry = makeEntry({
  id: "free-image",
  title: "Free Image Prompt",
  category: "Landing Page",
  media: "/media/free-image.webp",
  mediaType: "image",
  poster: null,
});
export const paidEntry = makeEntry({
  id: "paid-prompt",
  title: "Paid Prompt",
  category: "Finance",
  tier: "paid",
  priceAtomic: "500000",
});

/**
 * The real U2 catalog, reduced to its public face (bodies stripped) — what
 * `/v1/catalog` serves per the pinned U3<->U5 contract. Read from disk like
 * U1's reduced-motion test reads globals.css, so no resolveJsonModule dance.
 */
export function realCatalogEntries(): PublicCatalogEntry[] {
  const raw = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../backend/data/catalog.json",
    ),
    "utf8",
  );
  const file = JSON.parse(raw) as { entries: (PublicCatalogEntry & { body?: string })[] };
  return file.entries.map((row) => {
    const entry = { ...row };
    delete entry.body;
    return entry;
  });
}

/** fetch stub answering the pinned contract shapes for catalog + prompt routes. */
export function stubCatalogFetch(
  entries: PublicCatalogEntry[],
  bodies: Record<string, string> = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const promptMatch = url.match(/\/v1\/prompts\/([^/?]+)/);
    if (promptMatch) {
      const id = decodeURIComponent(promptMatch[1]);
      const body = bodies[id];
      if (body === undefined) return jsonResponse(404, { error: "not_found", message: "no such prompt" });
      return jsonResponse(200, { id, body });
    }
    const detailMatch = url.match(/\/v1\/catalog\/([^/?]+)/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      const entry = entries.find((e) => e.id === id);
      if (!entry) return jsonResponse(404, { error: "not_found", message: "no such entry" });
      return jsonResponse(200, entry);
    }
    if (url.includes("/v1/catalog")) {
      return jsonResponse(200, { entries, total: entries.length });
    }
    return jsonResponse(404, { error: "not_found", message: `unstubbed ${url}` });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

/**
 * IntersectionObserver stub. Instances register here; `intersect()` fires
 * every registered callback as if the observed elements scrolled into view.
 * Install BEFORE render; MediaPreview only attaches a video src once in view.
 */
export function stubIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  class FakeIO {
    constructor(cb: IntersectionObserverCallback) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIO as unknown as typeof IntersectionObserver);
  return {
    intersect() {
      for (const cb of callbacks) {
        cb(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          null as unknown as IntersectionObserver,
        );
      }
    },
  };
}

/** matchMedia stub; `matches` applies to the prefers-reduced-motion query. */
export function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? matches : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

/** Clipboard stub returning the captured writeText mock. */
export function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

/** jsdom's HTMLMediaElement lacks play/pause; give them harmless bodies. */
export function stubMediaElement() {
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
}
