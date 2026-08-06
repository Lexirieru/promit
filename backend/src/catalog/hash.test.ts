import { describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  test("is byte-exact: NFC and NFD spellings hash differently", () => {
    const nfd = FIXTURE_PROMPT.normalize("NFD");
    expect(nfd).not.toBe(FIXTURE_PROMPT);
    expect(computeContentHash(nfd)).not.toBe(computeContentHash(FIXTURE_PROMPT));
  });

  test("strips trailing whitespace but keeps leading and interior whitespace", () => {
    expect(computeContentHash(`${FIXTURE_PROMPT}  \n\t`)).toBe(
      computeContentHash(FIXTURE_PROMPT),
    );
    expect(computeContentHash(`\n\t  ${FIXTURE_PROMPT}`)).not.toBe(
      computeContentHash(FIXTURE_PROMPT),
    );
    expect(computeContentHash(FIXTURE_PROMPT.replace("\r\n\r\n", "\r\n"))).not.toBe(
      computeContentHash(FIXTURE_PROMPT),
    );
  });

  test("reproduces the docs/CONTENT-HASH.md test vectors", () => {
    expect(computeContentHash("Hello, Promit!\r\n")).toBe(
      "keccak256:89cbb515c1c9146172a51841911ccf5af5ef59400c65b25afbee9f10671b5be0",
    );
    expect(computeContentHash("Café hero")).toBe(
      "keccak256:9297b3de08f98de9085909a3999ff619bd18d8c2343f904a2c6cae01fc7c52eb",
    );
    expect(computeContentHash("Café hero")).toBe(
      "keccak256:b31c4715e3b9e55dc4e4815d65c1be1631f640967dac34f7522d064a84658414",
    );
    expect(computeContentHash("  Build a hero section.\nUse React.\t")).toBe(
      "keccak256:e6228f7eed1acc0a1325cbeee7f5e88c502f6dd60bcb393337632cbe14a68572",
    );
  });

  test("normalizeForHash matches the published two steps exactly", () => {
    expect(normalizeForHash("  a\r\nb\r c \n")).toBe("  a\nb\n c");
  });
});

describe("independent implementation from docs/CONTENT-HASH.md", () => {
  // The js-sha3 snippet is extracted from the doc and run verbatim: a keccak
  // implementation unrelated to viem/@noble/hashes reproducing the rule.
  test("doc's js-sha3 reference produces the same hashes", async () => {
    const docPath = fileURLToPath(new URL("../../../docs/CONTENT-HASH.md", import.meta.url));
    const doc = readFileSync(docPath, "utf8");
    const fences = [...doc.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const snippet = fences.find((f) => f.includes("js-sha3"));
    expect(snippet).toBeDefined();

    // Written next to this test so the snippet's `import "js-sha3"` resolves
    // against backend's node_modules, then imported as a real ES module.
    const snippetPath = fileURLToPath(
      new URL("./__content-hash-doc-snippet.tmp.mjs", import.meta.url),
    );
    writeFileSync(snippetPath, snippet!);
    try {
      const mod = (await import(snippetPath)) as {
        promitContentHash: (text: string) => string;
      };
      for (const text of [
        FIXTURE_PROMPT,
        "Hello, Promit!\r\n",
        "Café hero",
        "Café hero",
        "  Build a hero section.\nUse React.\t",
      ]) {
        expect(mod.promitContentHash(text)).toBe(computeContentHash(text));
      }
    } finally {
      unlinkSync(snippetPath);
    }
  });
});
