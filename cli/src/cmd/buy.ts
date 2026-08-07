import { defineCommand } from "citty";
import { confirm, isCancel, password } from "@clack/prompts";
import pc from "picocolors";

import {
  ContentHashMismatchError,
  PaymentRefusedError,
  SpendLedgerCorruptError,
  createPromitFetch,
  formatUsdc,
  usdcToAtomic,
  verifyContentHash,
} from "@promit/x402-client";

import { apiBaseUrl, fetchEntry, fetchFreeUnlock, unlockUrl, type PublicEntry, type UnlockSuccess } from "../api";
import { ENTITLEMENT_PROOF_HEADER, buildEntitlementProof } from "../entitlement";
import { emit, fail, note, stdinIsInteractive, success, warn } from "../output";
import { resolveSigner } from "../wallet/keystore";

/**
 * Delivered text goes to stdout ONLY; every receipt line goes to stderr, so
 * `promit buy id --yes > prompt.txt` captures exactly what was bought.
 *
 * On a content-hash mismatch the text is still emitted (the buyer paid for
 * it) but the process exits 1 with both hashes named — an unattended
 * pipeline must see the failure even though the bytes were delivered.
 */
function deliver(entry: PublicEntry, unlock: UnlockSuccess, json: boolean): never {
  const check = verifyContentHash(unlock.text, entry.contentHash);
  if (json) {
    emit(JSON.stringify({ ...unlock, hashVerified: check.ok }, null, 2));
  } else {
    emit(unlock.text);
  }
  note(pc.dim(`source: ${unlock.attribution.source} — ${unlock.attribution.note}`));
  if (unlock.alreadyOwned) {
    success(
      `already owned — no new charge${unlock.txHash ? ` (original tx ${unlock.txHash})` : ""}`,
    );
  } else if (unlock.txHash) {
    success(`paid — tx ${unlock.txHash} (${unlock.network ?? "unknown network"})`);
  }
  if (!check.ok) {
    fail(
      new ContentHashMismatchError(check.expectedHash, check.actualHash).message,
      "The delivered bytes differ from what the catalog promised before purchase.",
    );
  }
  success(`content hash verified: ${entry.contentHash}`);
  process.exit(0);
}

export default defineCommand({
  meta: {
    name: "buy",
    description: "Buy a prompt: pays the x402 challenge in USDC and prints the text",
  },
  args: {
    id: { type: "positional", required: true, description: "Prompt id to unlock" },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip the interactive confirmation (required on non-interactive stdin)",
    },
    "max-price": {
      type: "string",
      description: "Per-prompt cap in USDC (default $0.10); refuses to sign above it",
    },
    "session-cap": {
      type: "string",
      description: "Cumulative session cap in USDC (default $1.00); persists in the spend ledger",
    },
    keystore: { type: "string", description: "Keystore name under ~/.config/promit/keystores (default: default)" },
    api: { type: "string", description: "Promit API base URL (default: PROMIT_API_URL or http://localhost:3001)" },
    json: { type: "boolean", description: "Print the full unlock response as JSON" },
  },
  async run({ args }) {
    const base = apiBaseUrl(args.api);
    note(pc.dim(`fetching ${args.id} from ${base} …`));

    let entry: PublicEntry;
    try {
      entry = await fetchEntry(base, args.id);
    } catch (error) {
      fail((error as Error).message);
    }

    // R3: free tier needs no payment, no wallet, and no confirmation.
    if (entry.tier === "free") {
      try {
        const unlock = await fetchFreeUnlock(base, args.id);
        deliver(entry, unlock, args.json === true);
      } catch (error) {
        fail((error as Error).message);
      }
    }

    const price = formatUsdc(BigInt(entry.priceAtomic));

    // The non-interactive guard comes FIRST (plan U11): without --yes and
    // without a terminal there is nobody to answer a confirmation, and a
    // prompt would hang an unattended pipeline forever. Fail loudly instead.
    if (!args.yes && !stdinIsInteractive()) {
      fail(
        `"promit buy" needs --yes when stdin is not interactive: buying "${entry.id}" costs ${price} ` +
          `and there is no terminal to answer a confirmation prompt.`,
        `Re-run as: promit buy ${entry.id} --yes`,
      );
    }

    let perPromptCapAtomic: bigint | undefined;
    let sessionCapAtomic: bigint | undefined;
    try {
      if (args["max-price"]) perPromptCapAtomic = usdcToAtomic(args["max-price"]);
      if (args["session-cap"]) sessionCapAtomic = usdcToAtomic(args["session-cap"]);
    } catch (error) {
      fail((error as Error).message);
    }

    let signer;
    try {
      signer = await resolveSigner({
        keystoreName: args.keystore,
        promptPassword: async (file) => {
          if (!stdinIsInteractive()) {
            throw new Error(
              `keystore ${file} needs an interactive terminal for its password; ` +
                `set PROMIT_PRIVATE_KEY for unattended use`,
            );
          }
          const answer = await password({ message: `Password for ${file}:` });
          if (isCancel(answer)) {
            throw new Error("password entry cancelled");
          }
          return answer;
        },
      });
    } catch (error) {
      fail((error as Error).message);
    }
    note(pc.dim(`wallet ${signer.account.address} (${signer.source === "env" ? "PROMIT_PRIVATE_KEY" : signer.file})`));

    // Kepemilikan SEBELUM mesin pembayaran: pembeli yang kembali tidak
    // membayar ulang. Buktinya tanda tangan lokal gratis (EIP-191) — server
    // menjawab teks + alreadyOwned bila wallet ini punya unlock delivered,
    // dan 402 biasa bila tidak, yang jatuh ke jalur bayar di bawah.
    let probe: Response | null = null;
    try {
      probe = await fetch(unlockUrl(base, args.id), {
        headers: {
          Accept: "application/json",
          [ENTITLEMENT_PROOF_HEADER]: await buildEntitlementProof(signer.account, entry.id),
        },
      });
    } catch {
      // Katalog barusan terjangkau; anggap cegukan sesaat dan biarkan jalur
      // bayar (yang punya penanganan error lengkap) yang memutuskan.
      probe = null;
    }
    if (probe?.status === 200) {
      const owned = (await probe.json().catch(() => null)) as UnlockSuccess | null;
      if (owned?.alreadyOwned && typeof owned.text === "string") {
        note(pc.dim(`this wallet already unlocked "${entry.id}" — not paying again`));
        deliver(entry, owned, args.json === true);
      }
    } else if (probe?.status === 401) {
      // Bukti kami ditolak (jam mesin melenceng?). Melanjutkan berarti
      // menagih pemilik dua kali — kebalikan dari tujuan jalur ini.
      const body = (await probe.json().catch(() => null)) as { message?: string } | null;
      fail(
        `the ownership check was rejected: ${body?.message ?? "HTTP 401"}`,
        "Nothing was purchased. Check this machine's clock, then retry.",
      );
    }

    const handle = createPromitFetch({
      signer: signer.account,
      perPromptCapAtomic,
      sessionCapAtomic,
      onBeforePaymentCreation: async (context) => {
        const amount = formatUsdc(BigInt(context.selectedRequirements.amount));
        if (args.yes) {
          note(pc.dim(`paying ${amount} (pre-approved with --yes) …`));
          return;
        }
        const answer = await confirm({ message: `Pay ${amount} to unlock "${entry.id}"?` });
        if (isCancel(answer) || answer !== true) {
          return { abort: true, reason: "declined at the confirmation prompt" };
        }
      },
    });

    let response: Response;
    try {
      response = await handle.fetchWithPayment(unlockUrl(base, args.id));
    } catch (error) {
      if (error instanceof PaymentRefusedError || error instanceof SpendLedgerCorruptError) {
        fail((error as Error).message);
      }
      fail(`the purchase did not complete: ${(error as Error).message}`);
    }

    const body = (await response.json().catch(() => null)) as
      | (UnlockSuccess & { error?: string; message?: string })
      | null;
    if (!response.ok || body === null) {
      fail(
        body?.message ?? `the unlock endpoint answered HTTP ${response.status} with an unreadable body`,
      );
    }
    if (!body.txHash) {
      // settle.success + tx hash is the only unlock signal (R10); a 200
      // without one means the server contract drifted.
      warn("the unlock response carries no transaction hash; treat this purchase as unproven");
    }
    note(pc.dim(`session spend: ${formatUsdc(handle.ledger.spent())} of ${formatUsdc(handle.policy.sessionCapAtomic)}`));
    deliver(entry, body, args.json === true);
  },
});
