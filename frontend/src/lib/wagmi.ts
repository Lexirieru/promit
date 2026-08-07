import { http } from "wagmi";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { baseSepolia, type AppKitNetwork } from "@reown/appkit/networks";

/**
 * Wallet connection config (U6, reworked for Reown AppKit). One chain only:
 * every Promit payment is pinned to Base Sepolia by the shared client's
 * policy filter (KTD14), so offering other chains here would only
 * manufacture the wrong-chain state.
 *
 * AppKit wraps wagmi rather than replacing it: the WagmiAdapter now OWNS the
 * wagmi config, and everything downstream (useAccount, useSignTypedData,
 * lib/unlock.ts) keeps reading the same wagmi context it always did. No
 * connectors are listed here — createAppKit (lib/appkit.ts) discovers
 * injected wallets via EIP-6963 and adds WalletConnect + Coinbase itself.
 *
 * `ssr: true` defers connector hydration so server and first client render
 * agree on "disconnected".
 */

// Public by design (NEXT_PUBLIC_, documented in .env.example). The fallback
// is Reown's published localhost-only id so a fresh checkout still builds
// and runs locally; deployments must set the real id.
export const projectId =
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID || "b56e18d47c72ab683b10814fe9495694";

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [baseSepolia];

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
  transports: {
    // The chain's default public RPC (sepolia.base.org) — the transport U6
    // shipped with — instead of the Reown blockchain proxy, which is tied
    // to the project id's allowed origins.
    [baseSepolia.id]: http(),
  },
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

export { baseSepolia };
