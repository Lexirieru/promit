/**
 * Bukti kepemilikan untuk `promit buy`: sebelum menyentuh mesin pembayaran,
 * CLI menandatangani (EIP-191, lokal dan gratis) pesan kanonik di bawah dan
 * mengirimkannya di header — server menjawab teksnya bila wallet ini sudah
 * pernah membeli prompt itu, dan 402 biasa bila belum. Kepemilikan
 * dibuktikan, bukan diklaim: alamat polos bisa diketik siapa saja.
 *
 * Pesan MENCERMINKAN backend/src/entitlement.ts (dan
 * frontend/src/lib/entitlement.ts) — ubah ketiganya atau jangan sama sekali.
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

/** Nonce acak; cocok regex nonce backend, membuat tiap pesan unik. */
export function randomEntitlementNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Permukaan signer yang dibutuhkan: viem `PrivateKeyAccount` memenuhinya. */
export interface EntitlementSigner {
  address: string;
  signMessage(args: { message: string }): Promise<string>;
}

/** Nilai header `ENTITLEMENT-PROOF`: `<payer>|<nonce>|<issuedAt>|<sig>`. */
export async function buildEntitlementProof(
  signer: EntitlementSigner,
  promptId: string,
): Promise<string> {
  const nonce = randomEntitlementNonce();
  const issuedAt = Date.now().toString();
  const signature = await signer.signMessage({
    message: canonicalEntitlementMessage({ promptId, nonce, issuedAt }),
  });
  return [signer.address, nonce, issuedAt, signature].join("|");
}
