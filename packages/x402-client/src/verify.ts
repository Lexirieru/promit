import { keccak256, stringToBytes } from "viem";

import { ContentHashMismatchError } from "./errors";

/**
 * The published, byte-exact normalization rule behind every Promit content
 * hash (R12). A buyer must be able to recompute the hash independently, so
 * the rule is deliberately minimal:
 *
 *   1. Convert CRLF and lone CR line endings to LF.
 *   2. Strip trailing whitespace at the end of the text (not per line).
 *   3. Nothing else - no Unicode normalization, no case folding.
 *
 * The hash is keccak256 over the UTF-8 bytes of the normalized text, giving a
 * bytes32 the on-chain registry can store as-is.
 */
export function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
}

/** keccak256 of the UTF-8 bytes of the normalized text. */
export function hashPromptText(text: string): `0x${string}` {
  return keccak256(stringToBytes(normalizePromptText(text)));
}

export interface ContentHashCheck {
  ok: boolean;
  actualHash: `0x${string}`;
  expectedHash: string;
}

/**
 * Post-unlock check: recomputes the delivered text's hash and compares it to
 * the value the registry records. Returns a report instead of a boolean so a
 * mismatch can be shown with both hashes rather than swallowed.
 */
export function verifyContentHash(deliveredText: string, expectedHash: string): ContentHashCheck {
  const actualHash = hashPromptText(deliveredText);
  return {
    ok: actualHash.toLowerCase() === expectedHash.toLowerCase(),
    actualHash,
    expectedHash,
  };
}

/** Throwing form of {@link verifyContentHash} for callers on a straight-line path. */
export function assertContentHash(deliveredText: string, expectedHash: string): `0x${string}` {
  const check = verifyContentHash(deliveredText, expectedHash);
  if (!check.ok) {
    throw new ContentHashMismatchError(check.expectedHash, check.actualHash);
  }
  return check.actualHash;
}
