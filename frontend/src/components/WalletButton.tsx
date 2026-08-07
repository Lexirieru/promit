"use client";

import { useAppKit } from "@reown/appkit/react";
import { useAccount, useDisconnect } from "wagmi";
import { Wallet } from "lucide-react";

/** `0x1234…abcd` — enough to recognize, short enough for a button. */
export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Wallet connection control (U6, reworked for Reown AppKit). The button no
 * longer talks to one injected provider: it opens the AppKit modal, which
 * owns wallet choice (MetaMask, Coinbase, WalletConnect QR for mobile
 * wallets), connection progress, and connection errors. Only the two states
 * the page itself cares about live here: disconnected (open the modal) and
 * connected (truncated address + disconnect).
 */
export default function WalletButton() {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <div className="inline-flex items-center gap-2">
        <span
          aria-label={`Connected wallet ${address}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 font-mono text-xs text-gray-700"
        >
          <Wallet aria-hidden className="h-3.5 w-3.5" />
          {truncateAddress(address)}
        </span>
        <button
          type="button"
          onClick={() => disconnect()}
          className="rounded-full px-2 py-1 text-xs text-gray-500 transition-colors hover:text-black focus-visible:ring-2 focus-visible:ring-black focus-visible:outline-none"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => open()}
      className="inline-flex w-fit items-center gap-2 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      <Wallet aria-hidden className="h-4 w-4" />
      Connect wallet
    </button>
  );
}
