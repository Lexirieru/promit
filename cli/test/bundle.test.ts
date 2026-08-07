import { describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLI_DIR, freshConfigDir } from "./helpers";

/**
 * KTD11: the CLI ships as one bundled file with zero runtime dependencies,
 * run by node (never bun). The proof is mechanical: copy dist/cli.js into a
 * bare directory with no node_modules anywhere above it in spirit — any
 * surviving import would fail to resolve there — and run it under plain
 * node. This also exercises KTD12: figlet's font is baked into the bundle,
 * so startup performs no .flf disk read that could ENOENT.
 */
describe("bundled output", () => {
  test(
    "bun run build produces a node-runnable, dependency-free ESM bundle with the node shebang",
    async () => {
      const build = Bun.spawn(["bun", "run", "build"], {
        cwd: CLI_DIR,
        stdout: "pipe",
        stderr: "pipe",
      });
      const buildExit = await build.exited;
      if (buildExit !== 0) {
        throw new Error(`build failed: ${await new Response(build.stderr).text()}`);
      }

      const bundlePath = join(CLI_DIR, "dist", "cli.js");
      const firstLine = readFileSync(bundlePath, "utf8").split("\n", 1)[0];
      expect(firstLine).toBe("#!/usr/bin/env node");

      // A bare directory: no node_modules, no workspace, just the bundle and
      // a package.json declaring ESM (the .js extension needs it under node).
      const bare = freshConfigDir();
      copyFileSync(bundlePath, join(bare, "cli.js"));
      writeFileSync(join(bare, "package.json"), JSON.stringify({ type: "module" }));

      const run = Bun.spawn(["node", "cli.js", "--help"], {
        cwd: bare,
        env: { PATH: process.env.PATH ?? "", HOME: bare },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect(exitCode).toBe(0);
      for (const name of ["search", "preview", "buy", "verify", "wallet"]) {
        expect(stdout + stderr).toContain(name);
      }
    },
    120_000,
  );
});
