#!/usr/bin/env node
import { defineCommand, runMain, showUsage } from "citty";

import { printBanner } from "./banner";

/**
 * Entry point. Subcommands are lazy (KTD10): a `promit search` never loads
 * viem, ethers, or the payment client, keeping startup at citty's cost.
 * The shebang above is `node`, never `bun` (KTD11): the bundle from
 * `bun run build` (bun build --target node --format esm --minify) must run
 * for people who cloned the repo without bun. bun ignores the shebang when
 * running the source directly during development.
 */
const main = defineCommand({
  meta: {
    name: "promit",
    version: "0.1.0",
    description: "Promit pay-per-prompt marketplace CLI (Base Sepolia, x402)",
  },
  subCommands: {
    search: () => import("./cmd/search").then((m) => m.default),
    preview: () => import("./cmd/preview").then((m) => m.default),
    buy: () => import("./cmd/buy").then((m) => m.default),
    verify: () => import("./cmd/verify").then((m) => m.default),
    wallet: () => import("./cmd/wallet").then((m) => m.default),
  },
  async run({ rawArgs }) {
    // citty 0.2.2 also invokes this parent run AFTER a matched subcommand
    // finishes; the banner and usage belong to the bare invocation only.
    const first = rawArgs[0];
    if (first !== undefined && !first.startsWith("-")) {
      return;
    }
    printBanner();
    await showUsage(main);
  },
});

await runMain(main);
