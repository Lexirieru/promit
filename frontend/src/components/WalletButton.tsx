"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Wallet } from "lucide-react";

/** `0x1234…abcd` — enough to recognize, short enough for a button. */
export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Browser wallet connection control (U6). Three states, all named in the
 * UI: disconnected (connect via the injected provider), connecting, and
 * connected (address + disconnect). A missing browser wallet surfaces as an
 * inline message when the connect attempt fails — never a thrown error.
 */
export default function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
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
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={isPending}
        onClick={() => connect({ connector: connectors[0] })}
        className="inline-flex w-fit items-center gap-2 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-wait disabled:bg-gray-400"
      >
        <Wallet aria-hidden className="h-4 w-4" />
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          Couldn&apos;t connect: {error.message.split("\n")[0]}. Is a browser
          wallet (e.g. MetaMask) installed?
        </p>
      )}
    </div>
  );
}
