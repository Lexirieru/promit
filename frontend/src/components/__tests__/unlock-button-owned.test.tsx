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
import { fetchOwnedUnlocks } from "@/lib/api";
import { fetchOwnedPrompt } from "@/lib/entitlement";
import { UnlockFailedError, unlockPrompt, type UnlockedPrompt } from "@/lib/unlock";
import { paidEntry } from "./helpers";

/**
 * Jalur pembeli-yang-kembali di UnlockButton: wallet yang SUDAH memiliki
 * prompt tidak boleh melihat tombol tagih, dan membuka teksnya berjalan
 * lewat tanda tangan kepemilikan gratis (lib/entitlement), bukan lewat
 * mesin pembayaran (lib/unlock) — unlockPrompt tidak pernah tersentuh di
 * seluruh file ini.
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
  ...(await importOriginal<typeof import("@/lib/unlock")>()),
  unlockPrompt: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchOwnedUnlocks: vi.fn(),
}));

vi.mock("@/lib/entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlement")>()),
  fetchOwnedPrompt: vi.fn(),
}));

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const ORIGINAL_TX = `0x${"11".repeat(32)}`;

const ownedResult: UnlockedPrompt = {
  text: "THE PROMPT YOU ALREADY BOUGHT",
  txHash: ORIGINAL_TX,
  network: "eip155:84532",
  payer: ADDRESS,
  hashCheck: {
    ok: true,
    actualHash: `0x${"ab".repeat(32)}`,
    expectedHash: paidEntry.contentHash,
  },
  responseContentHash: paidEntry.contentHash,
  alreadyOwned: true,
};

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({
    address: ADDRESS,
    isConnected: true,
    chainId: baseSepolia.id,
  } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useSignTypedData).mockReturnValue({
    signTypedDataAsync: vi.fn(),
  } as unknown as ReturnType<typeof useSignTypedData>);
  vi.mocked(useSignMessage).mockReturnValue({
    signMessageAsync: vi.fn(async () => `0x${"ab".repeat(65)}`),
  } as unknown as ReturnType<typeof useSignMessage>);
  vi.mocked(useSwitchChain).mockReturnValue({
    switchChain: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useSwitchChain>);
  vi.mocked(useConnect).mockReturnValue({
    connect: vi.fn(),
    connectors: [{ id: "injected", name: "Injected" }],
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof useConnect>);
  vi.mocked(useDisconnect).mockReturnValue({
    disconnect: vi.fn(),
  } as unknown as ReturnType<typeof useDisconnect>);
  vi.mocked(fetchOwnedUnlocks).mockResolvedValue([
    {
      id: paidEntry.id,
      unlockedAt: "2026-08-07T00:00:00Z",
      txHash: ORIGINAL_TX,
      contentHash: paidEntry.contentHash,
    },
  ]);
  vi.mocked(fetchOwnedPrompt).mockResolvedValue(ownedResult);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UnlockButton — wallet yang sudah memiliki", () => {
  test("menampilkan status memiliki dan MENGGANTI tombol tagih dengan tombol lihat", async () => {
    render(<UnlockButton entry={paidEntry} />);

    expect(await screen.findByText(/you already own this prompt/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /view your unlocked prompt/i })).toBeTruthy();
    // Tombol berbayar hilang: tidak ada jalan mengklik diri sendiri ke
    // tagihan kedua.
    expect(screen.queryByRole("button", { name: /unlock paid prompt/i })).toBeNull();
    expect(screen.getByText(/nothing is paid again/i)).toBeTruthy();
  });

  test("melihat prompt berjalan lewat tanda tangan kepemilikan, tanpa mesin pembayaran", async () => {
    render(<UnlockButton entry={paidEntry} />);
    fireEvent.click(await screen.findByRole("button", { name: /view your unlocked prompt/i }));

    expect(await screen.findByText("THE PROMPT YOU ALREADY BOUGHT")).toBeTruthy();
    expect(screen.getByText(/re-opened without a new charge/i)).toBeTruthy();
    // Bukti pembelian orisinal tetap tertaut.
    const link = screen.getByRole("link", { name: /view settlement on basescan/i });
    expect(link.getAttribute("href")).toBe(`https://sepolia.basescan.org/tx/${ORIGINAL_TX}`);

    const request = vi.mocked(fetchOwnedPrompt).mock.calls[0]![0];
    expect(request.promptId).toBe(paidEntry.id);
    expect(request.payer).toBe(ADDRESS);
    expect(request.advertisedContentHash).toBe(paidEntry.contentHash);
    expect(vi.mocked(unlockPrompt)).not.toHaveBeenCalled();
  });

  test("server yang tidak mengakui kepemilikan menjadi error yang terlihat, bukan tagihan diam-diam", async () => {
    vi.mocked(fetchOwnedPrompt).mockRejectedValue(
      new UnlockFailedError(401, "entitlement_expired", "The entitlement proof is outside its validity window."),
    );
    render(<UnlockButton entry={paidEntry} />);
    fireEvent.click(await screen.findByRole("button", { name: /view your unlocked prompt/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/validity window/i);
    expect(vi.mocked(unlockPrompt)).not.toHaveBeenCalled();
  });

  test("wallet lain tetap melihat tombol tagih normal", async () => {
    vi.mocked(fetchOwnedUnlocks).mockResolvedValue([]);
    render(<UnlockButton entry={paidEntry} />);

    await act(async () => {});
    expect(screen.getByRole("button", { name: /unlock paid prompt/i })).toBeTruthy();
    expect(screen.queryByText(/you already own this prompt/i)).toBeNull();
  });

  test("probe kepemilikan yang gagal jatuh AMAN ke jalur bayar, tidak memblokir", async () => {
    vi.mocked(fetchOwnedUnlocks).mockRejectedValue(new Error("api down"));
    render(<UnlockButton entry={paidEntry} />);

    await act(async () => {});
    expect(screen.getByRole("button", { name: /unlock paid prompt/i })).toBeTruthy();
  });
});
