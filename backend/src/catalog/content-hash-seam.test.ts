import { describe, expect, test } from "bun:test";
import { hashPromptText, normalizePromptText, verifyContentHash } from "@promit/x402-client";
import { computeContentHash, normalizeForHash } from "./hash.ts";
import { loadCatalogFile } from "./index.ts";

/**
 * The AE7 seam: the hash the backend mints into the catalog and the hash the
 * buyer-side verifier recomputes MUST be the same digest, or every purchase
 * verification mismatches. The units shipped with different algorithms once
 * (SHA-256 vs keccak256) and no test caught it — this file is that test.
 */
const FIXTURES = [
  "Build a premium hero section called “Aura”.\r\nUse **React 18**.\r\n",
  "Hello, Promit!\r\n",
  "Café hero",
  "Café hero",
  "  leading stays\ntrailing goes  \t\n",
  "one line, no newline",
];

describe("content-hash seam: backend ↔ @promit/x402-client", () => {
  test("both packages produce the identical digest for the same text", () => {
    for (const text of FIXTURES) {
      expect(computeContentHash(text)).toBe(`keccak256:${hashPromptText(text).slice(2)}`);
    }
  });

  test("both packages normalize identically", () => {
    for (const text of FIXTURES) {
      expect(normalizeForHash(text)).toBe(normalizePromptText(text));
    }
  });

  test("the client verifier accepts the catalog rendering of the hash", () => {
    for (const text of FIXTURES) {
      expect(verifyContentHash(text, computeContentHash(text)).ok).toBe(true);
      expect(verifyContentHash(text, hashPromptText(text)).ok).toBe(true);
    }
  });

  test("every shipped catalog entry passes buyer-side verification", () => {
    const catalog = loadCatalogFile();
    expect(catalog.entries.length).toBeGreaterThan(0);
    for (const entry of catalog.entries) {
      expect(verifyContentHash(entry.body!, entry.contentHash).ok).toBe(true);
    }
  });
});
