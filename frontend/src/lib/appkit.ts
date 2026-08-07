"use client";

import { createAppKit } from "@reown/appkit/react";
import { networks, projectId, wagmiAdapter } from "@/lib/wagmi";

/**
 * AppKit initialization, imported for its side effect by app/providers.tsx.
 *
 * createAppKit must run ONCE at module scope — inside a component it would
 * re-run on re-render and corrupt modal state. It lives in its own module
 * rather than providers.tsx so tests that mount the real Providers can mock
 * exactly this seam: jsdom is not a browser AppKit can drive, and the modal
 * machinery fetches remote config the test fetch stubs would garble.
 */

// Wallets show this metadata in their connect prompt and verify `url`
// against the requesting origin — a hardcoded domain would mismatch
// localhost and every preview deploy.
const origin =
  typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;

createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  metadata: {
    name: "Promit",
    description: "Pay per prompt. Not per month.",
    url: origin,
    icons: [`${origin}/favicon.ico`],
  },
  features: {
    // Wallet picker only. Email/social login would mint embedded wallets
    // with no USDC on Base Sepolia — a dead end dressed up as an option —
    // and the analytics beacon is a third-party call the app doesn't need.
    email: false,
    socials: false,
    analytics: false,
  },
});
