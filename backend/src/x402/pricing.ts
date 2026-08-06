import type { Database } from "bun:sqlite";
import type { AssetAmount } from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC } from "@promit/x402-client";
import type { CatalogFile, PublicCatalogEntry } from "../catalog/index.ts";
import { listPublicEntries } from "../catalog/index.ts";
import { getListing, listingToPublicEntry } from "../db.ts";

/**
 * Per-prompt pricing for the x402 unlock route (R8/KTD1). The price is
 * function-valued: it resolves at request time from the same seed+listing
 * union the catalog routes serve, so a creator listing is purchasable the
 * moment it lands in SQLite without any route reconfiguration.
 */

/**
 * Same union rule as routes/catalog.ts: seed entries win on id collision,
 * so a listing can never shadow (or re-price) a versioned catalog entry.
 */
export function resolveUnionEntry(
  catalog: CatalogFile,
  db: Database,
  id: string,
): PublicCatalogEntry | null {
  const seed = listPublicEntries(catalog).find((entry) => entry.id === id);
  if (seed) return seed;
  const listing = getListing(db, id);
  return listing ? listingToPublicEntry(listing) : null;
}

/**
 * EIP-712 domain for the payment requirements' `extra` (KTD18). The server
 * is the party that AUTHORS `extra`, so the values come from @x402/evm's
 * maintained per-network table — the same table the facilitator's scheme
 * implementations use — not from a constant written here. §12 verified the
 * table's Base Sepolia row against the chain (`name='USDC'`, `version='2'`;
 * mainnet differs with `USD Coin`, which is why hardcoding is banned).
 *
 * The address assertion turns silent library drift (a bumped @x402/evm
 * pointing the network at another token) into a loud failure instead of a
 * payment demand denominated in an asset Promit does not accept (KTD14).
 */
function usdcEip712Domain(): { name: string; version: string } {
  const usdc = getDefaultAsset(BASE_SEPOLIA_NETWORK);
  if (usdc.address.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
    throw new Error(
      `@x402/evm default asset for ${BASE_SEPOLIA_NETWORK} is ${usdc.address}, ` +
        `but Promit only accepts USDC ${BASE_SEPOLIA_USDC} — refusing to build payment requirements`,
    );
  }
  return { name: usdc.name, version: usdc.version };
}

/**
 * The price of one paid prompt as an x402 v2 AssetAmount. `priceAtomic` is
 * already atomic USDC (6 decimals), so no money-string parsing is involved —
 * the catalog value goes onto the wire verbatim as `amount`.
 */
export function unlockPrice(entry: PublicCatalogEntry): AssetAmount {
  return {
    amount: entry.priceAtomic,
    asset: BASE_SEPOLIA_USDC,
    extra: usdcEip712Domain(),
  };
}
