import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { computeContentHash, normalizeForHash } from "./hash.ts";

const FIXTURE_PROMPT =
  "Build a premium hero section called “Aura”.\r\n" +
  "Use **React 18 + Tailwind CSS**.\r\n\r\n" +
  "\tThe background is `#0c0c0c` with a Café-style café accent.\r\n";

describe("computeContentHash", () => {
  test("is byte-stable across runs", () => {
    expect(computeContentHash(FIXTURE_PROMPT)).toBe(computeContentHash(FIXTURE_PROMPT));
  });

  test("changes when the text changes by one character", () => {
    expect(computeContentHash(FIXTURE_PROMPT)).not.toBe(
      computeContentHash(FIXTURE_PROMPT.replace("premium", "premiun")),
    );
  });

  test("absorbs CRLF vs LF vs CR transport differences", () => {
    const lf = FIXTURE_PROMPT.replaceAll("\r\n", "\n");
    const cr = lf.replaceAll("\n", "\r");
    expect(computeContentHash(lf)).toBe(computeContentHash(FIXTURE_PROMPT));
    expect(computeContentHash(cr)).toBe(computeContentHash(FIXTURE_PROMPT));
  });

  test("absorbs NFC vs NFD Unicode encodings", () => {
    const nfd = FIXTURE_PROMPT.normalize("NFD");
    expect(nfd).not.toBe(FIXTURE_PROMPT);
    expect(computeContentHash(nfd)).toBe(computeContentHash(FIXTURE_PROMPT));
  });

  test("trims the ends but preserves interior whitespace", () => {
    expect(computeContentHash(`\n\t  ${FIXTURE_PROMPT}  \n`)).toBe(
      computeContentHash(FIXTURE_PROMPT),
    );
    expect(computeContentHash(FIXTURE_PROMPT.replace("\r\n\r\n", "\r\n"))).not.toBe(
      computeContentHash(FIXTURE_PROMPT),
    );
  });

  test("reproduces the docs/CONTENT-HASH.md test vectors", () => {
    expect(computeContentHash("Hello, Promit!\r\n")).toBe(
      "sha256:256fc22ba98e6b8416dc08a1988be8b5e9315c42029a27a9c79674b5d81021ad",
    );
    expect(computeContentHash("Café hero")).toBe(
      "sha256:6662bf786352eb380baa42fcda09a1affce31638a0a7e983f1c1a42ccf00a052",
    );
    expect(computeContentHash("Café hero")).toBe(
      "sha256:6662bf786352eb380baa42fcda09a1affce31638a0a7e983f1c1a42ccf00a052",
    );
    expect(computeContentHash("  Build a hero section.\nUse React.\t")).toBe(
      "sha256:335966eee674a7f399c8cd890ee36574789a3f031eca40ce0e2ea81795b69cc5",
    );
  });

  test("normalizeForHash matches the published three steps exactly", () => {
    expect(normalizeForHash("  a\r\nb\r c \n")).toBe("a\nb\n c");
  });
});

describe("independent implementation from docs/CONTENT-HASH.md", () => {
  const python = spawnSync("python3", ["--version"]);
  const havePython = python.status === 0;

  // The Python snippet is copied verbatim from the doc: a different
  // language, Unicode library, and hash library reproducing the rule.
  test.skipIf(!havePython)("Python reference produces the same hash", () => {
    const script = [
      "import hashlib, sys, unicodedata",
      'text = sys.stdin.buffer.read().decode("utf-8")',
      'text = unicodedata.normalize("NFC", text)',
      'text = text.replace("\\r\\n", "\\n").replace("\\r", "\\n")',
      'text = text.strip(" \\t\\n\\r")',
      'print("sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest())',
    ].join("\n");
    const result = spawnSync("python3", ["-c", script], {
      input: FIXTURE_PROMPT,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(computeContentHash(FIXTURE_PROMPT));
  });
});
