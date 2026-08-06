import { createHash } from "node:crypto";

/**
 * Byte-exact content hash of a prompt body, per docs/CONTENT-HASH.md.
 *
 * The rule is published because AE7 promises a buyer can verify a delivered
 * prompt without trusting Promit — a hash over "normalized text" whose
 * normalization is secret still requires trusting us. Any change here is a
 * breaking protocol change and must update docs/CONTENT-HASH.md and every
 * stored hash in the same commit.
 *
 * Normalization (in this exact order):
 *   1. Unicode NFC normalization.
 *   2. Newline normalization: every CRLF (U+000D U+000A), then every
 *      remaining CR (U+000D), becomes LF (U+000A).
 *   3. Trim: remove leading and trailing characters from the set
 *      { U+0020 space, U+0009 tab, U+000A LF, U+000D CR }.
 *
 * Digest: SHA-256 over the UTF-8 bytes of the normalized text, rendered as
 * 64 lowercase hex characters, prefixed with "sha256:".
 */
export function computeContentHash(text: string): string {
  return `sha256:${createHash("sha256")
    .update(normalizeForHash(text), "utf8")
    .digest("hex")}`;
}

/** The published normalization from docs/CONTENT-HASH.md, exposed for tests. */
export function normalizeForHash(text: string): string {
  const nfc = text.normalize("NFC");
  const lf = nfc.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return trimHashWhitespace(lf);
}

function trimHashWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  const isTrimmable = (ch: string) =>
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  while (start < end && isTrimmable(text[start]!)) start += 1;
  while (end > start && isTrimmable(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}
