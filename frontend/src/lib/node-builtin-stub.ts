/**
 * Browser stand-in for `node:fs` / `node:os` / `node:path`, wired up via
 * `turbopack.resolveAlias` in next.config.ts (browser condition only — the
 * server keeps the real builtins).
 *
 * Why it exists: `@promit/x402-client` imports these at module top level for
 * its FILE spend ledger, and Turbopack refuses Node builtins in browser
 * chunks. The browser injects a Storage-backed ledger instead (lib/unlock.ts
 * always passes `ledger:` to `createPromitFetch`), so these names only need
 * to satisfy the import graph — they must never actually run. Each one
 * throws so an accidental future call fails loudly instead of corrupting
 * spend accounting silently.
 */
const refuse =
  (name: string) =>
  (): never => {
    throw new Error(
      `${name} is unavailable in the browser build; the file spend ledger is Node-only. ` +
        `Pass a Storage-backed ledger (see lib/unlock.ts).`,
    );
  };

export const mkdirSync = refuse("node:fs mkdirSync");
export const readFileSync = refuse("node:fs readFileSync");
export const renameSync = refuse("node:fs renameSync");
export const writeFileSync = refuse("node:fs writeFileSync");
export const homedir = refuse("node:os homedir");
export const dirname = refuse("node:path dirname");
export const join = refuse("node:path join");
