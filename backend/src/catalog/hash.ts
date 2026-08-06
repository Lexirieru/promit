import { hashPromptText, normalizePromptText } from "@promit/x402-client";

/**
 * Byte-exact content hash of a prompt body, per docs/CONTENT-HASH.md.
 *
 * The rule is published because AE7 promises a buyer can verify a delivered
 * prompt without trusting Promit — a hash over "normalized text" whose
 * normalization is secret still requires trusting us. Any change here is a
 * breaking protocol change and must update docs/CONTENT-HASH.md and every
 * stored hash in the same commit.
 *
 * The rule itself lives in @promit/x402-client (`normalizePromptText` +
 * `hashPromptText`) so the backend that mints hashes and the buyer-side
 * verifier can never disagree: CRLF/CR → LF, strip trailing whitespace at
 * the end of the text, keccak256 over the UTF-8 bytes. keccak256 (not
 * SHA-256) because PromitRegistry stores the digest as a native EVM bytes32.
 *
 * This function only renders that digest in the catalog form:
 * "keccak256:" + 64 lowercase hex characters. The client's `hashPromptText`
 * renders the same digest 0x-prefixed for the on-chain side; the client's
 * `verifyContentHash` accepts both renderings.
 */
export function computeContentHash(text: string): string {
  return `keccak256:${hashPromptText(text).slice(2)}`;
}

/** The published normalization from docs/CONTENT-HASH.md, exposed for tests. */
export const normalizeForHash = normalizePromptText;
