# Promit Content Hash

Every prompt in the Promit catalog carries a `contentHash`. It lets a buyer
verify — without trusting Promit — that the text delivered after payment is
exactly the text the listing promised. The rule below is normative and
byte-exact: an independent implementation that follows it must produce the
same hash for the same text, or Promit is in breach of it.

The reference implementation is `computeContentHash` in
`backend/src/catalog/hash.ts`. Where this document and the implementation
disagree, that is a bug in Promit; the document is the protocol.

## The rule

Given a prompt body as a Unicode string:

1. **Unicode normalization.** Apply Unicode Normalization Form C (NFC).
2. **Newline normalization.** Replace every CRLF pair (U+000D U+000A) with a
   single LF (U+000A), then replace every remaining CR (U+000D) with LF.
3. **Trim.** Remove leading and trailing characters belonging to the set
   { U+0020 SPACE, U+0009 TAB, U+000A LF, U+000D CR }. Interior whitespace,
   including blank lines and trailing spaces inside lines, is untouched.
4. **Digest.** Encode the result as UTF-8 and hash it with SHA-256.
5. **Render.** Write the digest as 64 lowercase hexadecimal characters and
   prefix it with the literal string `sha256:`.

Nothing else is normalized. Case, interior whitespace, markdown syntax, and
punctuation are all significant. Steps 1–3 exist only to absorb transport
artifacts (platform line endings, editor-added trailing newlines, and
composed-vs-decomposed Unicode); they never change what a human would read.

The steps must be applied in the order given. The order matters at step 3:
trailing LF characters produced by step 2 must be trimmed.

## Test vectors

An implementation is conformant when it reproduces all four vectors.
`\r`, `\n`, and `\t` denote CR, LF, and TAB; `́` denotes the combining
acute accent (decomposed form).

| Input (JavaScript string literal) | Normalized bytes (UTF-8) | Hash |
| --- | --- | --- |
| `"Hello, Promit!\r\n"` | `Hello, Promit!` | `sha256:256fc22ba98e6b8416dc08a1988be8b5e9315c42029a27a9c79674b5d81021ad` |
| `"Café hero"` (NFC, `é` = U+00E9) | `Café hero` | `sha256:6662bf786352eb380baa42fcda09a1affce31638a0a7e983f1c1a42ccf00a052` |
| `"Café hero"` (NFD) | `Café hero` | `sha256:6662bf786352eb380baa42fcda09a1affce31638a0a7e983f1c1a42ccf00a052` |
| `"  Build a hero section.\nUse React.\t"` | `Build a hero section.\nUse React.` | `sha256:335966eee674a7f399c8cd890ee36574789a3f031eca40ce0e2ea81795b69cc5` |

Note that the NFC and NFD spellings of `Café hero` hash identically — that is
step 1 doing its job — while any one-character edit to the visible text
produces a different hash.

## Verifying a purchase

1. Read `contentHash` from the catalog entry **before** buying.
2. After the unlock response arrives, run the delivered prompt body through
   the rule above.
3. The result must equal the catalog's `contentHash` and the hash echoed in
   the unlock response. If it does not, the content is not what was listed.

Reference implementation in Python, for independence from Promit's code:

```python
import hashlib, unicodedata

def promit_content_hash(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.strip(" \t\n\r")
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
```

## Stability

The rule is versioned by its prefix. `sha256:` hashes are computed exactly as
above, forever. If the rule ever has to change, the new rule gets a new
prefix and every stored hash is recomputed in the same change — a silent
re-normalization under the old prefix would break every buyer's verifier.
