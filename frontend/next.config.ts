import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
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
