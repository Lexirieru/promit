import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(selfPath), "..", "..");

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|mts|cjs|json)$/;
// Generated output, vendored deps, and prose (the plan doc names the old
// directory) are not import sites.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "out",
  "docs",
  "lib",
  "cache",
  "broadcast",
  "coverage",
  "public",
]);

function* codeFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* codeFiles(path);
    } else if (CODE_FILE.test(entry.name)) {
      yield path;
    }
  }
}

describe("landingpage removal", () => {
  it("landingpage/ no longer exists", () => {
    expect(existsSync(join(repoRoot, "landingpage"))).toBe(false);
  });

  it("no code file references landingpage", () => {
    const offenders = Array.from(codeFiles(repoRoot)).filter(
      (path) =>
        path !== selfPath && readFileSync(path, "utf8").includes("landingpage"),
    );
    expect(offenders).toEqual([]);
  });
});
