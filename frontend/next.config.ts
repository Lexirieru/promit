import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // AppKit's wagmi adapter drags in @coinbase/cdp-sdk (via the Base account
  // connector's Node entry), whose SVM payment path lazily imports the
  // uninstalled optional @x402/svm — Turbopack fails the SSR bundle trying
  // to resolve it statically. Left external, Node only resolves that import
  // if an SVM payment is ever signed, which this EVM-only app never does.
  serverExternalPackages: ["@coinbase/cdp-sdk"],
  turbopack: {
    // @promit/x402-client's file spend ledger imports Node builtins at module
    // top level; Turbopack refuses those in browser chunks. The browser never
    // runs that ledger (lib/unlock.ts injects a Storage-backed one), so the
    // browser condition resolves the builtins to a throwing stub instead.
    resolveAlias: {
      "node:fs": { browser: "./src/lib/node-builtin-stub.ts" },
      "node:os": { browser: "./src/lib/node-builtin-stub.ts" },
      "node:path": { browser: "./src/lib/node-builtin-stub.ts" },
    },
  },
};

export default nextConfig;
