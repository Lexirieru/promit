import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { baseSepolia } from "wagmi/chains";

import UnlockButton from "@/components/UnlockButton";
import {
  SignatureRejectedError,
  UnlockFailedError,
  unlockPrompt,
  type UnlockRequest,
  type UnlockedPrompt,
} from "@/lib/unlock";
import { paidEntry } from "./helpers";

/**
 * UnlockButton state machine (U6). The wallet stack is mocked at the wagmi
 * hook boundary and the payment flow at the lib/unlock boundary — the real
 * payment machinery behind that boundary is covered by unlock-flow.test.ts.
 */

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
  useSignMessage: vi.fn(),
  useSignTypedData: vi.fn(),
  useSwitchChain: vi.fn(),
}));

vi.mock("@/lib/unlock", async (importOriginal) => ({
  // Real classes stay real so `instanceof` in the component keeps working;
  // only the flow entry point is replaced.
  ...(await importOriginal<typeof import("@/lib/unlock")>()),
  unlockPrompt: vi.fn(),
}));

// The ownership probe answers "not owned" here so every scenario below keeps
// exercising the paid path; the owned path has its own test file.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchOwnedUnlocks: vi.fn(async () => []),
}));

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

const successResult: UnlockedPrompt = {
  text: "THE PAID PROMPT BODY",
  txHash: `0x${"11".repeat(32)}`,
  network: "eip155:84532",
  payer: ADDRESS,
  hashCheck: {
    ok: true,
    actualHash: `0x${"ab".repeat(32)}`,
    expectedHash: paidEntry.contentHash,
  },
  responseContentHash: paidEntry.contentHash,
};

const mismatchResult: UnlockedPrompt = {
  ...successResult,
  text: "TAMPERED BODY",
  hashCheck: {
    ok: false,
    actualHash: `0x${"cd".repeat(32)}`,
    expectedHash: paidEntry.contentHash,
  },
};

const switchChain = vi.fn();
const connect = vi.fn();

function mockWallet(overrides: { address?: typeof ADDRESS; isConnected?: boolean; chainId?: number } = {}) {
  vi.mocked(useAccount).mockReturnValue({
    address: ADDRESS,
    isConnected: true,
    chainId: baseSepolia.id,
    ...overrides,
  } as unknown as ReturnType<typeof useAccount>);
}

type Deferred = {
  resolve: (value: UnlockedPrompt) => void;
  reject: (reason: unknown) => void;
  request: UnlockRequest;
};

/** unlockPrompt as a hand-resolvable promise, capturing the request. */
function deferUnlock(): { deferred: () => Deferred } {
  let current: Deferred | null = null;
  vi.mocked(unlockPrompt).mockImplementation(
    (request: UnlockRequest) =>
      new Promise<UnlockedPrompt>((resolve, reject) => {
        current = { resolve, reject, request };
      }),
  );
  return {
    deferred: () => {
      if (!current) throw new Error("unlockPrompt was not called");
      return current;
    },
  };
}

beforeEach(() => {
  mockWallet();
  vi.mocked(useSignTypedData).mockReturnValue({
    signTypedDataAsync: vi.fn(),
  } as unknown as ReturnType<typeof useSignTypedData>);
  vi.mocked(useSignMessage).mockReturnValue({
    signMessageAsync: vi.fn(),
  } as unknown as ReturnType<typeof useSignMessage>);
  vi.mocked(useSwitchChain).mockReturnValue({
    switchChain,
    isPending: false,
  } as unknown as ReturnType<typeof useSwitchChain>);
  vi.mocked(useConnect).mockReturnValue({
    connect,
    connectors: [{ id: "injected", name: "Injected" }],
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof useConnect>);
  vi.mocked(useDisconnect).mockReturnValue({
    disconnect: vi.fn(),
  } as unknown as ReturnType<typeof useDisconnect>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const NO_GAS_COPY = /not a transaction, and it needs no gas/i;

describe("UnlockButton", () => {
  test("with no wallet connected it prompts connection instead of erroring, no-gas copy already visible", () => {
    mockWallet({ address: undefined, isConnected: false, chainId: undefined });
    render(<UnlockButton entry={paidEntry} />);

    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /unlock paid prompt/i })).toBeNull();
    expect(screen.getByText(NO_GAS_COPY)).toBeTruthy();
    expect(vi.mocked(unlockPrompt)).not.toHaveBeenCalled();
  });

  test("on the wrong chain it offers a switch to Base Sepolia", () => {
    mockWallet({ chainId: 1 });
    render(<UnlockButton entry={paidEntry} />);

    const switchButton = screen.getByRole("button", { name: /switch to base sepolia/i });
    expect(screen.queryByRole("button", { name: /unlock paid prompt/i })).toBeNull();
    fireEvent.click(switchButton);
    expect(switchChain).toHaveBeenCalledWith({ chainId: baseSepolia.id });
  });

  test("the no-gas, not-a-transaction message is inline on the control BEFORE any wallet prompt", () => {
    render(<UnlockButton entry={paidEntry} />);

    // Visible while idle, i.e. before the wallet dialog could possibly open.
    expect(screen.getByText(NO_GAS_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: /unlock paid prompt for \$0\.50/i })).toBeTruthy();
    expect(vi.mocked(unlockPrompt)).not.toHaveBeenCalled();
  });

  test("signing and settling are distinct named states, and a slow settle says so after a few seconds", async () => {
    vi.useFakeTimers();
    const { deferred } = deferUnlock();
    render(<UnlockButton entry={paidEntry} />);

    fireEvent.click(screen.getByRole("button", { name: /unlock paid prompt/i }));

    // Between click and signature: waiting on the wallet.
    expect(screen.getByText(/waiting for your signature/i)).toBeTruthy();
    expect(screen.getByText(/check your wallet/i)).toBeTruthy();

    // Signature returned: the named PENDING window between signature and
    // the verify+settle answer.
    act(() => deferred().request.onSigned?.());
    expect(screen.getByText(/verifying & settling payment/i)).toBeTruthy();
    expect(screen.getByText(/verifying and settling your USDC payment/i)).toBeTruthy();
    expect(screen.queryByText(/still settling/i)).toBeNull();

    // Past a few seconds the wait is named instead of left as a spinner.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/still settling/i)).toBeTruthy();

    await act(async () => {
      deferred().resolve(successResult);
    });
    expect(screen.getByText("THE PAID PROMPT BODY")).toBeTruthy();
  });

  test("a successful unlock reveals the text, links Basescan, and shows the hash match", async () => {
    const { deferred } = deferUnlock();
    render(<UnlockButton entry={paidEntry} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock paid prompt/i }));
    await act(async () => {
      deferred().resolve(successResult);
    });

    expect(screen.getByText("THE PAID PROMPT BODY")).toBeTruthy();
    const link = screen.getByRole("link", { name: /view settlement on basescan/i });
    expect(link.getAttribute("href")).toBe(
      `https://sepolia.basescan.org/tx/${successResult.txHash}`,
    );
    expect(screen.getByText(/content hash verified/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a content-hash mismatch is prominent: an alert naming both hashes, never a silent success", async () => {
    const { deferred } = deferUnlock();
    render(<UnlockButton entry={paidEntry} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock paid prompt/i }));
    await act(async () => {
      deferred().resolve(mismatchResult);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/content hash mismatch/i);
    expect(alert.textContent).toContain(mismatchResult.hashCheck.expectedHash);
    expect(alert.textContent).toContain(mismatchResult.hashCheck.actualHash);
    expect(screen.queryByText(/content hash verified/i)).toBeNull();
  });

  test("declining the signature returns to idle with an explanation - no stuck spinner", async () => {
    const { deferred } = deferUnlock();
    render(<UnlockButton entry={paidEntry} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock paid prompt/i }));

    await act(async () => {
      deferred().reject(new SignatureRejectedError());
    });

    // Back to a clickable idle control with the decline explained.
    const button = screen.getByRole("button", { name: /unlock paid prompt/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toMatch(/unlock for \$0\.50/i);
    expect(screen.getByText(/declined in the wallet/i)).toBeTruthy();
    expect(screen.queryByText(/waiting for your signature/i)).toBeNull();
    expect(screen.queryByText(/verifying & settling/i)).toBeNull();
  });

  test("a settlement failure surfaces the error and leaves the prompt locked", async () => {
    const { deferred } = deferUnlock();
    render(<UnlockButton entry={paidEntry} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock paid prompt/i }));

    await act(async () => {
      deferred().reject(
        new UnlockFailedError(402, "settlement_failed", "The facilitator refused to settle."),
      );
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/stays locked/i);
    expect(alert.textContent).toMatch(/the facilitator refused to settle/i);
    expect(screen.queryByText("THE PAID PROMPT BODY")).toBeNull();
    expect(screen.getByRole("button", { name: /unlock paid prompt/i })).toBeTruthy();
  });

  test("the flow is wired with the advertised price as the per-prompt cap and the catalog hash as expectation", () => {
    const { deferred } = deferUnlock();
    render(<UnlockButton entry={paidEntry} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock paid prompt/i }));

    const request = deferred().request;
    expect(request.promptId).toBe(paidEntry.id);
    expect(request.priceAtomic).toBe(paidEntry.priceAtomic);
    expect(request.advertisedContentHash).toBe(paidEntry.contentHash);
    expect(request.signer.address).toBe(ADDRESS);
  });
});
