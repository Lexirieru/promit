import { createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/**
 * Wallet connection config (U6). One chain only: every Promit payment is
 * pinned to Base Sepolia by the shared client's policy filter (KTD14), so
 * offering other chains here would only manufacture the wrong-chain state.
 * `ssr: true` defers connector hydration so server and first client render
 * agree on "disconnected".
 */
export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [injected()],
  transports: {
    [baseSepolia.id]: http(),
  },
  ssr: true,
});

export { baseSepolia };
