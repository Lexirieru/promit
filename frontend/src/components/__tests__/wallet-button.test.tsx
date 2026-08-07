import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAccount, useDisconnect } from "wagmi";
import { useAppKit } from "@reown/appkit/react";

import WalletButton, { truncateAddress } from "@/components/WalletButton";

// The modal (wallet list, progress, errors) is AppKit's own machinery and
// needs a real browser; this component's whole contract is that it calls
// open(). Mocking at the hook boundary mirrors the wagmi mocks below.
vi.mock("@reown/appkit/react", () => ({
  useAppKit: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useDisconnect: vi.fn(),
}));

const ADDRESS = "0x1111111111111111111111111111111111112222" as const;
const open = vi.fn();
const disconnect = vi.fn();

function mockConnection(overrides: {
  isConnected?: boolean;
  address?: typeof ADDRESS;
} = {}) {
  vi.mocked(useAppKit).mockReturnValue({
    open,
  } as unknown as ReturnType<typeof useAppKit>);
  vi.mocked(useAccount).mockReturnValue({
    address: overrides.address,
    isConnected: overrides.isConnected ?? false,
  } as unknown as ReturnType<typeof useAccount>);
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
  test("disconnected: the button opens the AppKit wallet modal", () => {
    render(<WalletButton />);
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(open).toHaveBeenCalled();
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
