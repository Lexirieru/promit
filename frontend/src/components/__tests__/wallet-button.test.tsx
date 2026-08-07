import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

import WalletButton, { truncateAddress } from "@/components/WalletButton";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
}));

const ADDRESS = "0x1111111111111111111111111111111111112222" as const;
const connect = vi.fn();
const disconnect = vi.fn();
const injectedConnector = { id: "injected", name: "Injected" };

function mockConnection(overrides: {
  isConnected?: boolean;
  address?: typeof ADDRESS;
  isPending?: boolean;
  error?: Error | null;
} = {}) {
  vi.mocked(useAccount).mockReturnValue({
    address: overrides.address,
    isConnected: overrides.isConnected ?? false,
  } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useConnect).mockReturnValue({
    connect,
    connectors: [injectedConnector],
    isPending: overrides.isPending ?? false,
    error: overrides.error ?? null,
  } as unknown as ReturnType<typeof useConnect>);
  vi.mocked(useDisconnect).mockReturnValue({
    disconnect,
  } as unknown as ReturnType<typeof useDisconnect>);
}

beforeEach(() => mockConnection());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WalletButton", () => {
  test("disconnected: offers connect via the injected provider", () => {
    render(<WalletButton />);
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(connect).toHaveBeenCalledWith({ connector: injectedConnector });
  });

  test("connecting: the pending state is named and the button disabled", () => {
    mockConnection({ isPending: true });
    render(<WalletButton />);
    const button = screen.getByRole("button", { name: /connecting/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("a failed connect surfaces an inline message instead of throwing", () => {
    mockConnection({ error: new Error("Provider not found.") });
    render(<WalletButton />);
    expect(screen.getByRole("alert").textContent).toMatch(/provider not found/i);
  });

  test("connected: shows the truncated address and disconnects on demand", () => {
    mockConnection({ isConnected: true, address: ADDRESS });
    render(<WalletButton />);
    expect(screen.getByText(truncateAddress(ADDRESS))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(disconnect).toHaveBeenCalled();
  });

  test("truncateAddress keeps both ends of the address", () => {
    expect(truncateAddress(ADDRESS)).toBe("0x1111…2222");
  });
});
