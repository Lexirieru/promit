import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { privateKeyToAccount } from "viem/accounts";

import {
  PAID_TEXT,
  PAID_TX_HASH,
  TEST_PRIVATE_KEY,
  freshConfigDir,
  runCli,
  startMockApi,
  type MockApi,
} from "./helpers";

/**
 * `promit buy` untuk pembeli yang kembali: wallet yang sudah memiliki
 * prompt TIDAK membayar ulang. Mock API memverifikasi bukti entitlement
 * dengan pemulihan tanda tangan viem sungguhan atas pesan kanonik yang
 * dicerminkan dari backend, jadi lolosnya tes ini berarti CLI membangun
 * bukti yang aturan verifikasi server terima — bukan sekadar menyetel
 * header.
 */

const OWNER_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY as `0x${string}`).address;

/** anvil #1 — pemilik lain; wallet CLI (anvil #0) TIDAK memiliki apa pun. */
const OTHER_OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("promit buy — pembeli yang kembali (entitlement)", () => {
  describe("wallet ini sudah memiliki prompt-nya", () => {
    let api: MockApi;
    beforeAll(() => {
      api = startMockApi({ ownedBy: [OWNER_ADDRESS] });
    });
    afterAll(() => api.stop());

    test("tidak membayar ulang: teks keluar tanpa satu pun PAYMENT-SIGNATURE", async () => {
      const before = api.requests.length;
      const result = await runCli(["buy", "paid-landing", "--yes"], {
        env: {
          PROMIT_API_URL: api.url,
          PROMIT_CONFIG_DIR: freshConfigDir(),
          PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
        },
      });

      expect(result.exitCode).toBe(0);
      // stdout tetap murni teks yang dibeli — kontrak `> prompt.txt`.
      expect(result.stdout).toBe(`${PAID_TEXT}\n`);
      expect(result.stderr).toContain("already owned");
      expect(result.stderr).toContain(PAID_TX_HASH);
      expect(result.stderr).toContain("content hash verified");
      // Bukti terkirim, pembayaran tidak pernah: unlock diselesaikan oleh
      // probe entitlement, tanpa tanda tangan pembayaran di request mana pun.
      const seen = api.requests.slice(before);
      expect(seen.some((r) => r.hasEntitlementProof)).toBe(true);
      expect(seen.filter((r) => r.hasPaymentSignature)).toHaveLength(0);
    });

    test("--json menyertakan penanda alreadyOwned untuk pipeline", async () => {
      const result = await runCli(["buy", "paid-landing", "--yes", "--json"], {
        env: {
          PROMIT_API_URL: api.url,
          PROMIT_CONFIG_DIR: freshConfigDir(),
          PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
        },
      });
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as { alreadyOwned?: boolean; hashVerified?: boolean };
      expect(body.alreadyOwned).toBe(true);
      expect(body.hashVerified).toBe(true);
    });
  });

  describe("wallet lain yang memiliki — bukan wallet ini", () => {
    let api: MockApi;
    beforeAll(() => {
      api = startMockApi({ ownedBy: [OTHER_OWNER] });
    });
    afterAll(() => api.stop());

    test("wallet lain tetap ditagih: jalur bayar berjalan penuh", async () => {
      const before = api.requests.length;
      const result = await runCli(["buy", "paid-landing", "--yes"], {
        env: {
          PROMIT_API_URL: api.url,
          PROMIT_CONFIG_DIR: freshConfigDir(),
          PROMIT_PRIVATE_KEY: TEST_PRIVATE_KEY,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${PAID_TEXT}\n`);
      // Dibayar sungguhan — bukan jalur already-owned.
      expect(result.stderr).toContain("paid — tx");
      expect(result.stderr).not.toContain("already owned");
      const seen = api.requests.slice(before);
      expect(seen.filter((r) => r.hasPaymentSignature)).toHaveLength(1);
    });
  });
});
