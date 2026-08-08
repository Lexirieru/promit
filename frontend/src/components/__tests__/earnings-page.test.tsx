import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({
  current: { address: undefined as string | undefined, isConnected: false },
}));
vi.mock("wagmi", () => ({
  useAccount: () => account.current,
  // Escrow reads/writes are exercised in claim-button.test.tsx; here the
  // dashboard is under test, so the chain is stubbed to an empty balance.
  usePublicClient: () => ({
    readContract: async () => 0n,
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }),
  useWriteContract: () => ({ writeContractAsync: async () => "0xhash" }),
}));
vi.mock("@/components/WalletButton", () => ({
  default: () => <button type="button">Connect wallet</button>,
}));

import EarningsPage from "@/app/earnings/page";

const CREATOR = "0xadE939F26516c657fc01f2eD1B069562b672644c";

/**
 * The creator dashboard. What is worth pinning is that the page never invents
 * a number: earned, unclaimed, buyers and purchases all come from the server,
 * and the two counts stay distinct because repeat custom is not reach.
 */

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    creator: CREATOR.toLowerCase(),
    feeBps: 250,
    feeLabel: "2.5%",
    totals: {
      listings: 1,
      sales: 3,
      buyers: 2,
      grossAtomic: "300000",
      feeAtomic: "7500",
      netAtomic: "292500",
      paidAtomic: "0",
      claimableAtomic: "292500",
    },
    listings: [
      {
        id: "hero-a",
        title: "Floating Navbar Hero",
        category: "Hero",
        priceAtomic: "100000",
        media: null,
        mediaType: "video",
        poster: null,
        buyers: 2,
        sales: 3,
        grossAtomic: "300000",
        feeAtomic: "7500",
        netAtomic: "292500",
        paidAtomic: "0",
        claimableAtomic: "292500",
      },
    ],
    ...overrides,
  };
}

const stubFetch = (body: unknown, ok = true) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response),
  );

beforeEach(() => {
  account.current = { address: CREATOR, isConnected: true };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("earnings page", () => {
  it("asks for a wallet before showing anyone's numbers", async () => {
    account.current = { address: undefined, isConnected: false };
    stubFetch(dashboard());

    render(<EarningsPage />);

    expect(screen.getByText(/Connect a wallet/)).toBeTruthy();
  });

  it("shows purchases and buyers as separate figures", async () => {
    stubFetch(dashboard());

    render(<EarningsPage />);
    await screen.findByRole("table");

    const row = screen.getByRole("row", { name: /Floating Navbar Hero/ });
    // Three purchases from two wallets: a creator reading "2" as sales would
    // undercount their revenue.
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("2");
  });

  it("renders earned and unclaimed as USDC, not atomic units", async () => {
    stubFetch(dashboard());

    render(<EarningsPage />);
    await screen.findByRole("table");

    expect(screen.getAllByText("$0.2925").length).toBeGreaterThan(0);
    expect(screen.queryByText("292500")).toBeNull();
  });

  it("names the fee rate rather than leaving the gap unexplained", async () => {
    stubFetch(dashboard());

    render(<EarningsPage />);
    await screen.findByRole("table");

    expect(screen.getByText(/2\.5% protocol/)).toBeTruthy();
  });

  it("offers a claim whose figure comes from the contract, not the table", async () => {
    // The table is Prom It's accounting; the contract is what will actually
    // pay. With nothing credited on chain yet, the control must say so rather
    // than promise the dashboard's number.
    stubFetch(dashboard());

    render(<EarningsPage />);
    await screen.findByRole("table");

    const claim = await screen.findByRole("button", { name: /claim/i });
    expect((claim as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/read from the contract/)).toBeTruthy();
  });

  it("points a creator with no listings at the listing page", async () => {
    stubFetch(dashboard({ listings: [], totals: { ...dashboard().totals, listings: 0 } }));

    render(<EarningsPage />);

    expect(await screen.findByText(/haven't listed a prompt yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "List a prompt" })).toBeTruthy();
  });

  it("offers a retry when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    render(<EarningsPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });
});
