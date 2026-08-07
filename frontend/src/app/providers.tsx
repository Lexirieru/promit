"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
// Side-effect import: runs createAppKit once, before any child can call an
// AppKit hook. Module evaluation order is the init-before-render guarantee.
import "@/lib/appkit";

/**
 * Client-side providers for the whole app: wagmi (wallet connection) on top
 * of TanStack Query (wagmi v3 requires it). The QueryClient lives in state,
 * not module scope, so a Fast Refresh or a second React root never shares
 * cache between renders.
 */
export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
