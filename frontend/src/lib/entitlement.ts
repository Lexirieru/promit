import { verifyContentHash } from "@promit/x402-client";

import { promptUrl } from "./api";
import {
  SignatureRejectedError,
  UnlockFailedError,
  isUserRejection,
  type UnlockedPrompt,
} from "./unlock";

/**
 * Jalur pembeli-yang-kembali: teks prompt yang SUDAH dibeli wallet ini,
 * tanpa pembayaran kedua. Kepemilikan dibuktikan dengan tanda tangan —
 * alamat polos bisa diketik siapa saja — jadi wallet personal_sign pesan
 * kanonik di bawah dan server memulihkan alamatnya sendiri.
 *
 * Pesan MENCERMINKAN backend/src/entitlement.ts (dan cli/src/entitlement.ts)
 * — ubah ketiganya atau jangan sama sekali. promptId masuk pesan dari sisi
 * server lewat path request, jadi tanda tangan prompt A tidak pernah
 * membuka prompt B; issuedAt (epoch ms) membatasi umur bukti ke menit.
 */

export const ENTITLEMENT_PROOF_HEADER = "ENTITLEMENT-PROOF";

/** MIRROR dari backend canonicalEntitlementMessage — jangan ubah sepihak. */
export function canonicalEntitlementMessage(fields: {
  promptId: string;
  nonce: string;
  issuedAt: string;
}): string {
  return ["promit.entitlement.v1", fields.promptId, fields.nonce, fields.issuedAt].join("|");
}

/** Nonce acak; cocok regex nonce backend, dan membuat tiap pesan unik. */
export function randomEntitlementNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface OwnedPromptRequest {
  promptId: string;
  payer: `0x${string}`;
  /** Catalog hash advertised before the ORIGINAL purchase — still the expectation. */
  advertisedContentHash: string;
  /** personal_sign seam — wagmi's `signMessageAsync` in the browser. */
  signMessage: (message: string) => Promise<`0x${string}`>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

interface OwnedResponseBody {
  text?: string;
  contentHash?: string;
  txHash?: string;
  network?: string;
  payer?: string;
  alreadyOwned?: boolean;
  error?: string;
  message?: string;
}

/**
 * Satu pengambilan bertanda tangan. Melempar {@link SignatureRejectedError}
 * bila pengguna menolak di wallet dan {@link UnlockFailedError} untuk
 * jawaban non-OK — termasuk 402, yang berarti server TIDAK mengakui
 * kepemilikan dan pemanggil tidak boleh diam-diam beralih ke jalur bayar.
 */
export async function fetchOwnedPrompt(request: OwnedPromptRequest): Promise<UnlockedPrompt> {
  const nonce = randomEntitlementNonce();
  const issuedAt = Date.now().toString();
  const message = canonicalEntitlementMessage({
    promptId: request.promptId,
    nonce,
    issuedAt,
  });

  let signature: `0x${string}`;
  try {
    signature = await request.signMessage(message);
  } catch (error) {
    if (isUserRejection(error)) throw new SignatureRejectedError();
    throw error;
  }

  const doFetch = request.fetch ?? fetch;
  const response = await doFetch(promptUrl(request.promptId), {
    headers: {
      Accept: "application/json",
      [ENTITLEMENT_PROOF_HEADER]: [request.payer, nonce, issuedAt, signature].join("|"),
    },
  });

  let body: OwnedResponseBody = {};
  try {
    body = (await response.json()) as OwnedResponseBody;
  } catch {
    // Non-JSON answers fall through to the status checks below.
  }

  if (!response.ok || body.alreadyOwned !== true || typeof body.text !== "string") {
    throw new UnlockFailedError(
      response.status,
      body.error,
      body.message ??
        "The server did not recognize this wallet's prior purchase. The prompt stays locked.",
    );
  }

  return {
    text: body.text,
    txHash: body.txHash ?? "",
    network: body.network ?? "",
    payer: body.payer ?? "",
    hashCheck: verifyContentHash(body.text, request.advertisedContentHash),
    responseContentHash: body.contentHash ?? "",
    alreadyOwned: true,
  };
}
