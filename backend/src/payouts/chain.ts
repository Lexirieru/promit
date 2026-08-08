import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * Every chain call the payout worker makes, behind one interface (the same
 * shape the settler uses for `RegistryChain`). The worker holds the decisions;
 * this file holds the RPC. Tests substitute a fake that COUNTS transfers,
 * which is the only way to assert that a retry sends zero of them.
 */

export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export interface PayoutChain {
  /** The wallet the payouts are sent FROM. */
  treasuryAddress: string;
  usdcBalance(address?: string): Promise<bigint>;
  ethBalance(): Promise<bigint>;
  /** Broadcasts a USDC transfer and returns its hash. */
  sendUsdc(to: string, amountAtomic: bigint): Promise<string>;
  /** Resolves once mined; `false` means the transaction reverted. */
  confirm(txHash: string): Promise<boolean>;
}

export interface PayoutChainConfig {
  treasuryPrivateKey: Hex;
  rpcUrl: string;
  usdcAddress?: string;
}

export function createPayoutChain(config: PayoutChainConfig): PayoutChain {
  const account = privateKeyToAccount(config.treasuryPrivateKey);
  const usdc = (config.usdcAddress ?? BASE_SEPOLIA_USDC) as `0x${string}`;
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });

  return {
    treasuryAddress: account.address,
    usdcBalance: (address) =>
      publicClient.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [(address ?? account.address) as `0x${string}`],
      }),
    ethBalance: () => publicClient.getBalance({ address: account.address }),
    sendUsdc: (to, amountAtomic) =>
      walletClient.writeContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to as `0x${string}`, amountAtomic],
      }),
    confirm: async (txHash) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
      return receipt.status === "success";
    },
  };
}

/** Refusals that stop the worker before it can move money badly. */
export class PayoutPreflightError extends Error {
  constructor(
    readonly code:
      | "treasury_mismatch"
      | "treasury_underfunded"
      | "treasury_out_of_gas"
      | "no_recipient",
    message: string,
  ) {
    super(message);
    this.name = "PayoutPreflightError";
  }
}

/** Below this the worker refuses to start rather than fail mid-drain. */
export const DEFAULT_MIN_ETH_WEI = 500_000_000_000_000n; // 0.0005 ETH

export interface PreflightInput {
  chain: PayoutChain;
  /** The address x402 told buyers to pay. */
  payTo: string;
  /** Sum of everything currently owed to creators. */
  owedAtomic: bigint;
  minEthWei?: bigint;
}

/**
 * Refuses to start on a misconfiguration, with a named reason.
 *
 * The mismatch check is the important one. Buyers paid `PAY_TO_ADDRESS`; if
 * the key configured here belongs to a different wallet, the worker would send
 * creators money from somewhere else entirely — either failing on an empty
 * balance, or worse, succeeding and draining an unrelated wallet while the
 * treasury quietly accumulates what it owes. Same-address is the invariant
 * that makes "the treasury pays out what it took in" true.
 */
export async function preflight(input: PreflightInput): Promise<void> {
  const { chain, payTo, owedAtomic, minEthWei = DEFAULT_MIN_ETH_WEI } = input;

  if (chain.treasuryAddress.toLowerCase() !== payTo.toLowerCase()) {
    throw new PayoutPreflightError(
      "treasury_mismatch",
      `the payout key controls ${chain.treasuryAddress} but buyers paid ${payTo} — ` +
        `payouts must come from the wallet that received the payments`,
    );
  }

  const balance = await chain.usdcBalance();
  if (balance < owedAtomic) {
    throw new PayoutPreflightError(
      "treasury_underfunded",
      `treasury holds ${balance} atomic USDC but ${owedAtomic} is owed to creators`,
    );
  }

  const eth = await chain.ethBalance();
  if (eth < minEthWei) {
    throw new PayoutPreflightError(
      "treasury_out_of_gas",
      `treasury holds ${eth} wei, below the ${minEthWei} wei needed to send payouts`,
    );
  }
}
