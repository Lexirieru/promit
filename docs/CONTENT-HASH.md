# Promit Content Hash

Every prompt in the Promit catalog carries a `contentHash`. It lets a buyer
verify — without trusting Promit — that the text delivered after payment is
exactly the text the listing promised. The rule below is normative and
byte-exact: an independent implementation that follows it must produce the
same hash for the same text, or Promit is in breach of it.

The reference implementation is `normalizePromptText` + `hashPromptText` in
`packages/x402-client/src/verify.ts`; the backend renders the same digest via
`computeContentHash` in `backend/src/catalog/hash.ts`. Where this document
and the implementations disagree, that is a bug in Promit; the document is
the protocol.

## The rule

Given a prompt body as a Unicode string:

1. **Newline normalization.** Replace every CRLF pair (U+000D U+000A) with a
   single LF (U+000A), then replace every remaining CR (U+000D) with LF.
2. **Trailing trim.** Remove trailing characters at the end of the text (not
   per line) belonging to the whitespace set listed below. Leading and
   interior whitespace, including blank lines and trailing spaces inside
   lines, is untouched.
3. **Digest.** Encode the result as UTF-8 and hash it with keccak-256 (the
   original Keccak padding as used by Ethereum, **not** NIST SHA3-256).
4. **Render.** Catalog form: the digest as 64 lowercase hexadecimal
   characters prefixed with the literal string `keccak256:`. On-chain form:
   the same 32 digest bytes as the registry's `bytes32` (`0x`-prefixed when
   written in hex). The two renderings carry the same digest and verifiers
   must accept either.

The whitespace set for step 2 is exactly the set matched by JavaScript's
`\s` regex class: U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR,
U+0020 SPACE, U+00A0 NO-BREAK SPACE, U+1680, U+2000–U+200A, U+2028 LS,
U+2029 PS, U+202F, U+205F, U+3000, and U+FEFF. In JavaScript, steps 1–2 are
precisely:

```js
text.replace(/\r\n?/g, "\n").replace(/\s+$/u, "")
```

Nothing else is normalized. **There is no Unicode normalization**: NFC and
NFD spellings of the same visible text hash differently, and leading
whitespace is significant. Case, interior whitespace, markdown syntax, and
punctuation are all significant. Steps 1–2 exist only to absorb the two
transport artifacts that survive JSON (platform line endings and
editor-added trailing newlines); they never change what a human would read.

The steps must be applied in the order given: trailing LF characters
produced by step 1 must be trimmed by step 2.

## Test vectors

An implementation is conformant when it reproduces all four vectors.
`\r`, `\n`, and `\t` denote CR, LF, and TAB; `́` denotes the combining
acute accent (U+0301, decomposed form).

| Input (JavaScript string literal) | Normalized bytes (UTF-8) | Hash |
| --- | --- | --- |
| `"Hello, Promit!\r\n"` | `Hello, Promit!` | `keccak256:89cbb515c1c9146172a51841911ccf5af5ef59400c65b25afbee9f10671b5be0` |
| `"Café hero"` (NFC, `é` = U+00E9) | `Café hero` | `keccak256:9297b3de08f98de9085909a3999ff619bd18d8c2343f904a2c6cae01fc7c52eb` |
| `"Café hero"` (NFD, `e` + U+0301) | `Cafe` + U+0301 + ` hero` (11 UTF-8 bytes) | `keccak256:b31c4715e3b9e55dc4e4815d65c1be1631f640967dac34f7522d064a84658414` |
| `"  Build a hero section.\nUse React.\t"` | `  Build a hero section.\nUse React.` | `keccak256:e6228f7eed1acc0a1325cbeee7f5e88c502f6dd60bcb393337632cbe14a68572` |

Note that the NFC and NFD spellings hash **differently** — the rule is
byte-exact and performs no Unicode normalization — and that the leading two
spaces in the last vector survive while the trailing tab is stripped.

## Verifying a purchase

1. Read `contentHash` from the catalog entry **before** buying.
2. After the unlock response arrives, run the delivered prompt body through
   the rule above.
3. The result must equal the catalog's `contentHash`, the hash echoed in the
   unlock response, and the `bytes32` the on-chain registry stores for the
   listing (same digest, `0x`-prefixed). If it does not, the content is not
   what was listed.

Reference implementation using `js-sha3`, a keccak implementation
independent of the one Promit's code uses (viem/`@noble/hashes`):

```js
import { keccak256 } from "js-sha3";

export function promitContentHash(text) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
  return "keccak256:" + keccak256(normalized);
}
```

## Stability

The rule is versioned by its prefix. `keccak256:` hashes are computed
exactly as above, forever. If the rule ever has to change, the new rule gets
a new prefix and every stored hash is recomputed in the same change — a
silent re-normalization under the old prefix would break every buyer's
verifier. The launch-era `sha256:` prefix (NFC + edge-trim + SHA-256) was
retired before any hash left the repository: the on-chain registry stores a
keccak digest as `bytes32`, so the catalog rule was unified onto keccak-256
and no `sha256:` hash remains valid anywhere.
