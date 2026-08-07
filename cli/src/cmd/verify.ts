import { readFileSync } from "node:fs";

import { defineCommand } from "citty";
import pc from "picocolors";

import { verifyContentHash } from "@promit/x402-client";

import { apiBaseUrl, fetchEntry } from "../api";
import { emit, fail, note, readAllStdin, stdinIsInteractive, warn } from "../output";
import {
  findListingForPrompt,
  readListing,
  registryAddress,
  registryClient,
  rpcUrl,
  type OnchainListing,
} from "../registry";

/**
 * AE7: recompute the delivered text's hash under the published rule
 * (docs/CONTENT-HASH.md) and compare it against what the REGISTRY stores,
 * read over RPC — never against Promit's API answer, which is the party
 * being checked. The catalog is consulted only to locate the listing and to
 * cover prompts that have no on-chain listing yet (clearly labeled).
 */

async function readDeliveredText(file?: string): Promise<string> {
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      fail(`could not read ${file}: ${(error as Error).message}`);
    }
  }
  if (stdinIsInteractive()) {
    fail(
      "verify needs the delivered text: pass a file argument or pipe the text on stdin",
      "Example: promit verify email-landing-page prompt.txt",
    );
  }
  const text = await readAllStdin();
  if (text.length === 0) {
    fail("stdin closed without any text to verify");
  }
  return text;
}

function report(expected: string, expectedSource: string, text: string): never {
  const check = verifyContentHash(text, expected);
  note(`  recomputed  ${check.actualHash}`);
  note(`  stored      ${check.expectedHash}  (${expectedSource})`);
  if (check.ok) {
    emit(pc.green("MATCH — the delivered text is exactly what was listed."));
    process.exit(0);
  }
  emit(pc.red("MISMATCH — the delivered text is NOT what was listed. Do not trust this content."));
  process.exit(1);
}

export default defineCommand({
  meta: {
    name: "verify",
    description: "Check delivered prompt text against the on-chain registry hash",
  },
  args: {
    ref: {
      type: "positional",
      required: true,
      description: "Catalog prompt id (e.g. email-landing-page) or numeric on-chain listing id",
    },
    file: {
      type: "positional",
      required: false,
      description: "File holding the delivered text (omit to read stdin)",
    },
    rpc: { type: "string", description: "Base Sepolia RPC URL (default: PROMIT_RPC_URL / BASE_SEPOLIA_RPC_URL)" },
    registry: { type: "string", description: "PromitRegistry proxy address" },
    api: { type: "string", description: "Promit API base URL, used to resolve catalog ids" },
  },
  async run({ args }) {
    const text = await readDeliveredText(args.file);
    const client = registryClient(rpcUrl(args.rpc));
    const registry = registryAddress(args.registry);

    // Numeric ref: straight to the chain, no API involved at all.
    if (/^\d+$/.test(args.ref)) {
      const listingId = BigInt(args.ref);
      let listing: OnchainListing;
      try {
        listing = await readListing(client, registry, listingId);
      } catch (error) {
        fail(
          `could not read listing ${listingId} from registry ${registry}: ${(error as Error).message}`,
        );
      }
      note(pc.dim(`registry ${registry} · listing ${listingId}${listing.active ? "" : " (inactive)"}`));
      report(listing.contentHash, `on-chain listing ${listingId}`, text);
    }

    // Catalog id: use the API only to learn the claimed hash (a locator),
    // then anchor the verdict on-chain when a listing exists.
    let catalogHash: string | null = null;
    try {
      const entry = await fetchEntry(apiBaseUrl(args.api), args.ref);
      catalogHash = entry.contentHash;
    } catch (error) {
      warn(`could not resolve "${args.ref}" in the catalog: ${(error as Error).message}`);
    }

    let scan;
    try {
      scan = await findListingForPrompt(
        client,
        registry,
        args.ref,
        catalogHash ? catalogHash.replace(/^keccak256:/, "") : null,
      );
    } catch (error) {
      fail(`could not read registry ${registry} over RPC: ${(error as Error).message}`);
    }
    if (scan.truncated) {
      warn(`registry scan stopped after ${scan.scanned} listings; pass a numeric listing id to go direct`);
    }

    if (scan.listing) {
      note(pc.dim(`registry ${registry} · listing ${scan.listing.listingId} (${scan.listing.metadataURI || "no metadataURI"})`));
      report(scan.listing.contentHash, `on-chain listing ${scan.listing.listingId}`, text);
    }

    if (catalogHash === null) {
      fail(
        `"${args.ref}" has no on-chain listing in ${registry} and could not be resolved in the catalog; ` +
          `nothing to verify against.`,
      );
    }
    warn(
      `no on-chain listing found for "${args.ref}" in ${registry}; comparing against the catalog's ` +
        `own claim — this trusts Promit's API, which on-chain verification exists to avoid.`,
    );
    report(catalogHash, "catalog claim, NOT on-chain", text);
  },
});
