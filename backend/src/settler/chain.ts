import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  toBytes,
} from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * The settler's entire view of Base Sepolia, as one injectable interface.
 * Everything above this seam (queue draining, idempotency reads, receipt
 * confirmation, preflight) is exercised by tests against a fake; everything
 * below it is viem calls with no decisions in them.
 */

/** Registry surface the settler uses — mirrors smartcontract/src/PromitRegistry.sol. */
const REGISTRY_ABI = parseAbi([
  "function registerListing(address creator, bytes32 contentHash, uint256 price, string metadataURI) returns (uint256)",
  "function recordUnlock(address payer, bytes32 nonce, uint256 listingId, uint256 amount)",
  "function isUnlocked(address payer, bytes32 nonce) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event ListingRegistered(uint256 indexed listingId, address indexed creator, bytes32 contentHash, uint256 price, string metadataURI)",
]);

const LISTING_REGISTERED_EVENT = parseAbiItem(
  "event ListingRegistered(uint256 indexed listingId, address indexed creator, bytes32 contentHash, uint256 price, string metadataURI)",
);

export const SETTLER_ROLE: Hex = keccak256(toBytes("SETTLER_ROLE"));
export const UPGRADER_ROLE: Hex = keccak256(toBytes("UPGRADER_ROLE"));
export const DEFAULT_ADMIN_ROLE: Hex = `0x${"00".repeat(32)}`;

/**
 * Catalog content hashes are `keccak256:<64 hex>` (docs/CONTENT-HASH.md);
 * the registry stores the same digest as a native bytes32. Anything else is
 * a corrupt row and must fail loudly rather than land on-chain as garbage.
 */
export function contentHashToBytes32(contentHash: string): Hex {
  const match = /^keccak256:([0-9a-f]{64})$/.exec(contentHash);
  if (!match) {
    throw new Error(
      `content hash "${contentHash}" does not match the published ` +
        `"keccak256:<64 lowercase hex>" rule — refusing to register it on-chain`,
    );
  }
  return `0x${match[1]}` as Hex;
}

export interface RegisteredListing {
  listingId: bigint;
  txHash: string;
}

export interface RegistryChain {
  /** Address whose key signs settler transactions. */
  settlerAddress: string;
  getEthBalance(): Promise<bigint>;
  hasRole(role: Hex, account: string): Promise<boolean>;
  /** The stored-key idempotency read (R19): MUST be consulted before recordUnlock. */
  isUnlocked(payer: string, nonce: Hex): Promise<boolean>;
  /**
   * Crash-recovery read for listings: registerListing has no on-chain
   * duplicate guard, so before sending, look for an existing
   * ListingRegistered event carrying this content hash.
   */
  findListingByContentHash(contentHash: Hex): Promise<RegisteredListing | null>;
  /** null = the chain has never seen this hash (not "not yet indexed here"). */
  getTransactionReceipt(txHash: string): Promise<{ status: "success" | "reverted" } | null>;
  registerListing(args: {
    creator: string;
    contentHash: Hex;
    price: bigint;
    metadataURI: string;
  }): Promise<RegisteredListing>;
  recordUnlock(args: {
    payer: string;
    nonce: Hex;
    listingId: bigint;
    amount: bigint;
  }): Promise<{ txHash: string }>;
}

export interface RegistryChainConfig {
  rpcUrl: string;
  registryAddress: string;
  settlerPrivateKey: Hex;
  /**
   * Lower bound for the ListingRegistered log scan. Public RPCs cap
   * eth_getLogs ranges; pinning this to the deploy block keeps the
   * crash-recovery read cheap and reliable.
   */
  deployBlock?: bigint;
}

export function createRegistryChain(config: RegistryChainConfig): RegistryChain {
  const account = privateKeyToAccount(config.settlerPrivateKey);
  const registry = config.registryAddress as Address;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(config.rpcUrl),
  });

  async function write(
    functionName: "registerListing" | "recordUnlock",
    args: readonly unknown[],
  ) {
    // Simulate first: a revert costs no gas and surfaces the contract's
    // named error instead of burning ETH on a transaction that no-ops.
    const { request } = await publicClient.simulateContract({
      account,
      address: registry,
      abi: REGISTRY_ABI,
      functionName,
      args: args as never,
    });
    const txHash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`registry ${functionName} transaction ${txHash} reverted`);
    }
    return { txHash, receipt };
  }

  return {
    settlerAddress: account.address,

    getEthBalance: () => publicClient.getBalance({ address: account.address }),

    hasRole: (role, address) =>
      publicClient.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "hasRole",
        args: [role, address as Address],
      }),

    isUnlocked: (payer, nonce) =>
      publicClient.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "isUnlocked",
        args: [payer as Address, nonce],
      }),

    async findListingByContentHash(contentHash) {
      // contentHash is not an indexed event arg, so the node cannot filter
      // on it — fetch this registry's ListingRegistered logs and match here.
      const logs = await publicClient.getLogs({
        address: registry,
        event: LISTING_REGISTERED_EVENT,
        fromBlock: config.deployBlock ?? "earliest",
        toBlock: "latest",
      });
      for (const log of logs) {
        if (log.args.contentHash === contentHash && log.args.listingId !== undefined) {
          return { listingId: log.args.listingId, txHash: log.transactionHash ?? "" };
        }
      }
      return null;
    },

    async getTransactionReceipt(txHash) {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      } catch (error) {
        // viem throws TransactionReceiptNotFoundError for an unknown hash;
        // that is a definitive "chain never saw it", distinct from RPC
        // failures, which propagate and stay retryable.
        if ((error as { name?: string }).name === "TransactionReceiptNotFoundError") {
          return null;
        }
        throw error;
      }
      return { status: receipt.status === "success" ? "success" : "reverted" };
    },

    async registerListing({ creator, contentHash, price, metadataURI }) {
      const { txHash, receipt } = await write("registerListing", [
        creator as Address,
        contentHash,
        price,
        metadataURI,
      ]);
      const events = parseEventLogs({
        abi: REGISTRY_ABI,
        logs: receipt.logs,
        eventName: "ListingRegistered",
      });
      const listingId = events[0]?.args.listingId;
      if (listingId === undefined) {
        throw new Error(
          `registry registerListing transaction ${txHash} emitted no ListingRegistered event`,
        );
      }
      return { listingId, txHash };
    },

    async recordUnlock({ payer, nonce, listingId, amount }) {
      const { txHash } = await write("recordUnlock", [payer as Address, nonce, listingId, amount]);
      return { txHash };
    },
  };
}
