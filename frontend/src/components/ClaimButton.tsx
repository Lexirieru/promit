"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatUsdc } from "@/lib/api";

/**
 * Withdraws a creator's escrow balance.
 *
 * The number shown here is read from the CONTRACT, not from the API. The
 * dashboard's "unclaimed" column is Prom It's own accounting; this is what the
 * chain will actually pay out. When they disagree the chain is right, and a
 * creator about to sign a transaction deserves the figure that governs it.
 *
 * `claim()` takes no amount and no recipient: the whole balance goes to the
 * caller. So there is nothing to configure here and no way to misdirect it.
 */

export const REGISTRY_ADDRESS = "0x30c92fFadAd24Ca079227A92A33b78683D36Fde6" as const;

export const REGISTRY_ABI = [
  {
    type: "function",
    name: "claimableOf",
    stateMutability: "view",
    inputs: [{ name: "creator", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
] as const;

type Phase =
  | { name: "loading" }
  | { name: "ready"; claimable: bigint }
  | { name: "signing" }
  | { name: "confirming"; hash: `0x${string}` }
  | { name: "done"; hash: `0x${string}`; amount: bigint }
  | { name: "failed"; message: string; claimable: bigint };

export default function ClaimButton() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  const readClaimable = useCallback(async (): Promise<bigint> => {
    if (!publicClient || !address) return 0n;
    return publicClient.readContract({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "claimableOf",
      args: [address],
    });
  }, [publicClient, address]);

  useEffect(() => {
    if (!isConnected || !address) return;
    let cancelled = false;
    readClaimable()
      .then((claimable) => {
        if (!cancelled) setPhase({ name: "ready", claimable });
      })
      .catch(() => {
        // A read failure is not a claim failure: show zero rather than an
        // alarming error for something the creator did not attempt.
        if (!cancelled) setPhase({ name: "ready", claimable: 0n });
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, address, readClaimable]);

  async function claim(claimable: bigint) {
    try {
      setPhase({ name: "signing" });
      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "claim",
      });
      setPhase({ name: "confirming", hash });
      await publicClient?.waitForTransactionReceipt({ hash });
      setPhase({ name: "done", hash, amount: claimable });
    } catch (error) {
      const rejected =
        error instanceof Error && /reject|denied|4001/i.test(error.message);
      setPhase({
        name: "failed",
        claimable,
        message: rejected
          ? "The wallet rejected the transaction. Nothing was claimed and your balance is untouched."
          : "The claim did not go through. Your balance is untouched, so it is safe to try again.",
      });
    }
  }

  if (!isConnected) return null;

  if (phase.name === "done") {
    return (
      <div role="status" className="rounded-2xl border border-black px-5 py-4">
        <p className="text-sm font-medium text-black">
          Claimed {formatUsdc(phase.amount.toString())} to your wallet.
        </p>
        <a
          href={`https://sepolia.basescan.org/tx/${phase.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gray-600 underline underline-offset-2"
        >
          View the transaction on Basescan
        </a>
      </div>
    );
  }

  const claimable =
    phase.name === "ready" || phase.name === "failed" ? phase.claimable : null;
  const busy = phase.name === "signing" || phase.name === "confirming";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || claimable === null || claimable === 0n}
          onClick={() => claimable && claim(claimable)}
          className="inline-flex items-center gap-2 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <Wallet aria-hidden className="h-4 w-4" />
          {phase.name === "signing"
            ? "Waiting for your wallet…"
            : phase.name === "confirming"
              ? "Confirming on Base Sepolia…"
              : claimable && claimable > 0n
                ? `Claim ${formatUsdc(claimable.toString())}`
                : "Nothing to claim yet"}
        </button>
        {claimable !== null && claimable > 0n && (
          <span className="text-xs text-gray-600">
            Sends your whole balance to this wallet. You pay the gas.
          </span>
        )}
      </div>

      {phase.name === "failed" && (
        <p role="alert" className="text-xs text-red-700">
          {phase.message}
        </p>
      )}

      {claimable === 0n && (
        // Says which number governs, so a creator whose dashboard shows an
        // amount is not left thinking the button is broken.
        <p className="text-xs text-gray-500">
          Earnings become claimable once the sale is recorded on chain. The
          figure above is read from the contract, not from this site.
        </p>
      )}
    </div>
  );
}
