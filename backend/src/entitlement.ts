import { recoverMessageAddress } from "viem";

/**
 * Bukti kepemilikan (entitlement) untuk pembeli yang kembali.
 *
 * Tabel `unlocks` sudah tahu siapa membeli apa, tapi sebelum ini tidak ada
 * yang mengeksposnya — pembeli yang kembali DITAGIH LAGI untuk prompt yang
 * sudah dia miliki. Perbaikannya harus dibuktikan, bukan diklaim: alamat di
 * query string bisa diketik siapa saja, jadi tanpa tanda tangan endpoint ini
 * bukan perbaikan double-charge melainkan paywall bypass — siapa pun yang
 * tahu alamat seorang pembeli mendapat prompt berbayar gratis.
 *
 * Maka klien menandatangani (EIP-191 personal_sign, seam yang sama dengan
 * listing U7) pesan kanonik yang MENYEBUT prompt yang diminta plus waktu
 * terbit, dan server memulihkan alamat penanda tangan sendiri:
 *
 *   promit.entitlement.v1|<promptId>|<nonce>|<issuedAt>
 *
 * - promptId diambil dari PATH request, bukan dari klaim klien — tanda
 *   tangan untuk prompt A tidak pernah membuka prompt B.
 * - issuedAt (epoch milidetik) membatasi umur bukti: bukti yang bocor di log
 *   atau proxy kedaluwarsa dalam hitungan menit, bukan selamanya.
 * - nonce membuat setiap pesan unik sehingga wallet tidak pernah diminta
 *   menandatangani byte yang identik dua kali.
 *
 * Pesan ini DICERMINKAN di frontend/src/lib/entitlement.ts dan
 * cli/src/entitlement.ts — ubah ketiganya atau jangan sama sekali.
 */

export const ENTITLEMENT_MESSAGE_PREFIX = "promit.entitlement.v1";

/** Umur maksimum bukti. Cukup untuk satu round trip, terlalu pendek untuk log scraping. */
export const ENTITLEMENT_MAX_AGE_MS = 5 * 60_000;
/** Toleransi jam klien yang berjalan mendahului server. */
export const ENTITLEMENT_MAX_FUTURE_SKEW_MS = 60_000;

/** Header yang membawa bukti: `<payer>|<nonce>|<issuedAt>|<signature>`. */
export const ENTITLEMENT_PROOF_HEADER = "ENTITLEMENT-PROOF";

export interface EntitlementProof {
  payer: string;
  nonce: string;
  issuedAt: string;
  signature: string;
}

const PAYER_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const ISSUED_AT_RE = /^\d{1,16}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export function canonicalEntitlementMessage(fields: {
  promptId: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    ENTITLEMENT_MESSAGE_PREFIX,
    fields.promptId,
    fields.nonce,
    fields.issuedAt,
  ].join("|");
}

export interface ProofSource {
  header: (name: string) => string | undefined;
  query: (name: string) => string | undefined;
}

/**
 * Membaca bukti dari header `ENTITLEMENT-PROOF` (pilihan klien kami —
 * header tidak mendarat di access log) atau dari query
 * `?payer&nonce&issuedAt&signature` (jalur curl). `null` berarti request
 * tidak MENCOBA membuktikan kepemilikan sama sekali; bukti yang dicoba tapi
 * cacat dikembalikan apa adanya supaya verifikasi bisa MENOLAKNYA dengan
 * jelas — klaim payer tanpa tanda tangan tidak boleh diam-diam jatuh ke
 * jalur tagih, apalagi ke jalur gratis.
 */
export function readEntitlementProof(source: ProofSource): EntitlementProof | null {
  const header = source.header(ENTITLEMENT_PROOF_HEADER);
  if (header !== undefined) {
    const [payer = "", nonce = "", issuedAt = "", signature = ""] = header.split("|");
    return { payer, nonce, issuedAt, signature };
  }
  if (source.query("payer") !== undefined) {
    return {
      payer: source.query("payer") ?? "",
      nonce: source.query("nonce") ?? "",
      issuedAt: source.query("issuedAt") ?? "",
      signature: source.query("signature") ?? "",
    };
  }
  return null;
}

export type EntitlementVerdict =
  | { ok: true; payer: string }
  | { ok: false; code: "entitlement_malformed" | "entitlement_expired" | "entitlement_signature_mismatch"; message: string };

/**
 * Memverifikasi bukti terhadap prompt yang DIMINTA. Urutan penolakan:
 * format → jendela waktu → pemulihan tanda tangan. Alamat yang dipulihkan
 * dibandingkan lowercase (EIP-55 hanya kapitalisasi tampilan, aturan yang
 * sama dengan idempoteni R19 di tabel unlocks).
 */
export async function verifyEntitlementProof(
  proof: EntitlementProof,
  promptId: string,
  now: number = Date.now(),
): Promise<EntitlementVerdict> {
  if (
    !PAYER_RE.test(proof.payer) ||
    !NONCE_RE.test(proof.nonce) ||
    !ISSUED_AT_RE.test(proof.issuedAt) ||
    !SIGNATURE_RE.test(proof.signature)
  ) {
    return {
      ok: false,
      code: "entitlement_malformed",
      message:
        "An entitlement proof needs payer, nonce, issuedAt (epoch ms), and a 65-byte signature. " +
        "An address alone proves nothing — anyone can type someone else's address.",
    };
  }

  const issuedAt = Number(proof.issuedAt);
  if (now - issuedAt > ENTITLEMENT_MAX_AGE_MS || issuedAt - now > ENTITLEMENT_MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      code: "entitlement_expired",
      message:
        "The entitlement proof is outside its validity window. Sign a fresh message " +
        "(and check the client clock if this repeats).",
    };
  }

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: canonicalEntitlementMessage({
        promptId,
        nonce: proof.nonce,
        issuedAt: proof.issuedAt,
      }),
      signature: proof.signature as `0x${string}`,
    });
  } catch {
    return {
      ok: false,
      code: "entitlement_signature_mismatch",
      message: "The entitlement signature could not be recovered.",
    };
  }

  if (recovered.toLowerCase() !== proof.payer.toLowerCase()) {
    return {
      ok: false,
      code: "entitlement_signature_mismatch",
      message: "The entitlement signature was not made by the claimed payer address.",
    };
  }

  return { ok: true, payer: recovered.toLowerCase() };
}
