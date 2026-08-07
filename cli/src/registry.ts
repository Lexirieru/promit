import { createPublicClient, http, type Address, type PublicClient } from "viem";

/**
 * Read-only view of PromitRegistry for `promit verify` (AE7): the stored
 * content hash comes from the chain over RPC, never from Promit's API, so a
 * buyer verifies without trusting Promit's own answer.
 */

/** ERC1967 proxy on Base Sepolia, source-verified (see README.md). */
export const DEFAULT_REGISTRY_ADDRESS = "0x30c92fFadAd24Ca079227A92A33b78683D36Fde6";
export const DEFAULT_RPC_URL = "https://sepolia.base.org";

/** Resolution order: --rpc flag > PROMIT_RPC_URL > BASE_SEPOLIA_RPC_URL > public RPC. */
export function rpcUrl(flag?: string): string {
  return flag || process.env.PROMIT_RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL;
}

/** Resolution order: --registry flag > PROMIT_REGISTRY_ADDRESS > deployed proxy. */
export function registryAddress(flag?: string): Address {
  return (flag || process.env.PROMIT_REGISTRY_ADDRESS || DEFAULT_REGISTRY_ADDRESS) as Address;
}

export const registryAbi = [
  {
    type: "function",
    name: "listingCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getListing",
    stateMutability: "view",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "contentHash", type: "bytes32" },
          { name: "price", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
] as const;

export interface OnchainListing {
  listingId: bigint;
  creator: Address;
  contentHash: `0x${string}`;
  price: bigint;
  active: boolean;
  metadataURI: string;
}

export function registryClient(rpc: string): PublicClient {
  return createPublicClient({ transport: http(rpc) });
}

export async function readListingCount(client: PublicClient, address: Address): Promise<bigint> {
  return client.readContract({ address, abi: registryAbi, functionName: "listingCount" });
}

export async function readListing(
  client: PublicClient,
  address: Address,
  listingId: bigint,
): Promise<OnchainListing> {
  const listing = await client.readContract({
    address,
    abi: registryAbi,
    functionName: "getListing",
    args: [listingId],
  });
  return { listingId, ...listing };
}

/**
 * Registration is settler-driven (U10) and the metadataURI convention is the
 * settler's, so matching is a heuristic: the URI carries the prompt id as a
 * terminal path/URN segment. Boundary-anchored on purpose — a bare
 * `includes` would let "hero" claim "hero-section".
 */
export function metadataMatchesPrompt(metadataURI: string, promptId: string): boolean {
  const uri = metadataURI.replace(/\.json$/, "");
  return uri === promptId || uri.endsWith(`/${promptId}`) || uri.endsWith(`:${promptId}`);
}

/** How far the scan walks before giving up; the registry is demo-sized. */
const SCAN_LIMIT = 500n;

export interface ListingScan {
  listing: OnchainListing | null;
  scanned: bigint;
  truncated: boolean;
}

/**
 * Finds the on-chain listing for a catalog prompt id: first by metadataURI,
 * then by digest equality with the catalog's claimed hash. The digest
 * fallback still anchors trust on-chain — it only helps LOCATE the listing;
 * the comparison `verify` prints is always against the chain's bytes.
 */
export async function findListingForPrompt(
  client: PublicClient,
  address: Address,
  promptId: string,
  catalogDigest: string | null,
): Promise<ListingScan> {
  const count = await readListingCount(client, address);
  const limit = count > SCAN_LIMIT ? SCAN_LIMIT : count;
  let byDigest: OnchainListing | null = null;
  for (let id = 1n; id <= limit; id++) {
    const listing = await readListing(client, address, id);
    if (metadataMatchesPrompt(listing.metadataURI, promptId)) {
      return { listing, scanned: id, truncated: false };
    }
    if (
      byDigest === null &&
      catalogDigest !== null &&
      listing.contentHash.toLowerCase() === `0x${catalogDigest}`.toLowerCase()
    ) {
      byDigest = listing;
    }
  }
  return { listing: byDigest, scanned: limit, truncated: count > SCAN_LIMIT };
}
