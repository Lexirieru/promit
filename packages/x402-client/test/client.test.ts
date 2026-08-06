import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

import {
  BASE_SEPOLIA_NETWORK,
  BASE_SEPOLIA_USDC,
  PerPromptCapExceededError,
  PolicyRefusalError,
  SessionCapExceededError,
  createPromitFetch,
  type ClientEvmSigner,
  type FetchLike,
} from "../src";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const RESOURCE_URL = "https://api.promit.test/unlock/prompt-1";

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    asset: BASE_SEPOLIA_USDC,
    amount: "50000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

function countingSigner(): { signer: ClientEvmSigner; signatures: () => number } {
  let count = 0;
  const signer: ClientEvmSigner = {
    address: "0x1111111111111111111111111111111111111111",
    async signTypedData() {
      count += 1;
      return `0x${"ab".repeat(65)}` as `0x${string}`;
    },
  };
  return { signer, signatures: () => count };
}

/**
 * A fake unlock endpoint: 402 with a v2 PAYMENT-REQUIRED header until a
 * PAYMENT-SIGNATURE header arrives, then 200 with the prompt body.
 */
function fakeServer(accepts: PaymentRequirements[], promptBody = "PAID PROMPT BODY") {
  const paid: Request[] = [];
  const fetchMock: FetchLike = async (input, init) => {
    const request = new Request(input as Request | string | URL, init);
    if (!request.headers.has("PAYMENT-SIGNATURE")) {
      return new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: RESOURCE_URL },
            accepts,
          }),
        },
      });
    }
    paid.push(request);
    return new Response(promptBody, {
      status: 200,
      headers: {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader({
          success: true,
          transaction: `0x${"11".repeat(32)}`,
          network: BASE_SEPOLIA_NETWORK,
          payer: "0x1111111111111111111111111111111111111111",
        }),
      },
    });
  };
  return { fetchMock, paid };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "promit-client-"));
}

describe("createPromitFetch", () => {
  test("a non-402 response passes through without payment", async () => {
    const { signer, signatures } = countingSigner();
    const handle = createPromitFetch({
      signer,
      configDir: freshDir(),
      fetch: async () => new Response("free content", { status: 200 }),
    });
    const response = await handle.fetchWithPayment(RESOURCE_URL);
    expect(await response.text()).toBe("free content");
    expect(signatures()).toBe(0);
    expect(handle.ledger.spent()).toBe(0n);
  });

  test("AE4: a demand above the per-prompt cap is refused before any signature, naming both amounts", async () => {
    const { signer, signatures } = countingSigner();
    const { fetchMock } = fakeServer([requirement({ amount: "5000000" })]);
    const handle = createPromitFetch({
      signer,
      perPromptCapAtomic: 100_000n,
      configDir: freshDir(),
      fetch: fetchMock,
    });
    try {
      await handle.fetchWithPayment(RESOURCE_URL);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PerPromptCapExceededError);
      expect((error as Error).message).toContain("$5.00");
      expect((error as Error).message).toContain("$0.10");
    }
    expect(signatures()).toBe(0);
    expect(handle.ledger.spent()).toBe(0n);
  });

  test("AE11: a different asset is refused before any signature even though the amount is below the cap", async () => {
    const { signer, signatures } = countingSigner();
    const { fetchMock } = fakeServer([
      requirement({ asset: "0xdEAD00000000000000000000000000000000dEaD", amount: "50000" }),
    ]);
    const handle = createPromitFetch({ signer, configDir: freshDir(), fetch: fetchMock });
    await expect(handle.fetchWithPayment(RESOURCE_URL)).rejects.toThrow(PolicyRefusalError);
    expect(signatures()).toBe(0);
  });

  test("AE11: a different network is refused before any signature", async () => {
    const { signer, signatures } = countingSigner();
    const { fetchMock } = fakeServer([requirement({ network: "eip155:1", amount: "50000" })]);
    const handle = createPromitFetch({ signer, configDir: freshDir(), fetch: fetchMock });
    await expect(handle.fetchWithPayment(RESOURCE_URL)).rejects.toThrow(PolicyRefusalError);
    expect(signatures()).toBe(0);
  });

  test("a scheme that is not exact is refused before any signature", async () => {
    const { signer, signatures } = countingSigner();
    const { fetchMock } = fakeServer([requirement({ scheme: "upto" })]);
    const handle = createPromitFetch({ signer, configDir: freshDir(), fetch: fetchMock });
    await expect(handle.fetchWithPayment(RESOURCE_URL)).rejects.toThrow(PolicyRefusalError);
    expect(signatures()).toBe(0);
  });

  test("a conforming under-cap requirement is paid: one signature, spend recorded, body delivered", async () => {
    const { signer, signatures } = countingSigner();
    const { fetchMock, paid } = fakeServer([requirement()]);
    const handle = createPromitFetch({ signer, configDir: freshDir(), fetch: fetchMock });

    const response = await handle.fetchWithPayment(RESOURCE_URL);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PAID PROMPT BODY");
    expect(signatures()).toBe(1);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.headers.get("PAYMENT-SIGNATURE")).toBeTruthy();
    expect(handle.ledger.spent()).toBe(50_000n);
  });

  test("AE8 across restarts: a sixth $0.10 purchase is refused once five have settled, with no new signature", async () => {
    const dir = freshDir();
    const { fetchMock } = fakeServer([requirement({ amount: "100000" })]);

    for (let purchase = 0; purchase < 5; purchase++) {
      // A fresh handle per purchase simulates a restarted process; only the
      // on-disk ledger carries the running total forward.
      const { signer } = countingSigner();
      const handle = createPromitFetch({
        signer,
        sessionCapAtomic: 500_000n,
        configDir: dir,
        fetch: fetchMock,
      });
      const response = await handle.fetchWithPayment(RESOURCE_URL);
      expect(response.status).toBe(200);
    }

    const { signer, signatures } = countingSigner();
    const handle = createPromitFetch({
      signer,
      sessionCapAtomic: 500_000n,
      configDir: dir,
      fetch: fetchMock,
    });
    try {
      await handle.fetchWithPayment(RESOURCE_URL);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCapExceededError);
      expect((error as SessionCapExceededError).spentAtomic).toBe(500_000n);
      expect((error as Error).message).toContain("$0.50");
    }
    expect(signatures()).toBe(0);
    expect(handle.ledger.spent()).toBe(500_000n);
  });

  test("the onBeforePaymentCreation hook observes the selected requirement before signing", async () => {
    const { signer } = countingSigner();
    const { fetchMock } = fakeServer([requirement()]);
    const seen: string[] = [];
    const handle = createPromitFetch({
      signer,
      configDir: freshDir(),
      fetch: fetchMock,
      onBeforePaymentCreation: async (context) => {
        seen.push(context.selectedRequirements.amount);
      },
    });
    await handle.fetchWithPayment(RESOURCE_URL);
    expect(seen).toEqual(["50000"]);
  });

  test("an aborting onBeforePaymentCreation hook vetoes the payment: no signature, no spend", async () => {
    const { signer, signatures } = countingSigner();
    const { fetchMock, paid } = fakeServer([requirement()]);
    const handle = createPromitFetch({
      signer,
      configDir: freshDir(),
      fetch: fetchMock,
      onBeforePaymentCreation: async () => ({ abort: true, reason: "operator declined" }),
    });
    try {
      await handle.fetchWithPayment(RESOURCE_URL);
      throw new Error("expected a veto");
    } catch (error) {
      expect((error as Error).message).toContain("operator declined");
    }
    expect(signatures()).toBe(0);
    expect(paid).toHaveLength(0);
    expect(handle.ledger.spent()).toBe(0n);
  });

  test("a signing failure refunds the charged amount", async () => {
    const failingSigner: ClientEvmSigner = {
      address: "0x1111111111111111111111111111111111111111",
      async signTypedData() {
        throw new Error("keystore unavailable");
      },
    };
    const { fetchMock } = fakeServer([requirement()]);
    const handle = createPromitFetch({ signer: failingSigner, configDir: freshDir(), fetch: fetchMock });
    await expect(handle.fetchWithPayment(RESOURCE_URL)).rejects.toThrow();
    expect(handle.ledger.spent()).toBe(0n);
  });
});
