/**
 * Kirim listing kreator ke POST /v1/listings — klien alternatif dari form
 * /list (alur disetujui koordinator karena popup wallet extension tidak
 * bisa diotomasi). Autentikasi identik dengan browser: EIP-191 atas pesan
 * kanonik dari backend/src/catalog/listing.ts; server tetap memulihkan
 * alamat dan menolak bila tidak cocok.
 *
 * Pakai: CREATOR_PRIVATE_KEY=0x… bun run submit-listing.ts \
 *   --api http://localhost:3001 --title "…" --category "Landing Page" \
 *   --price 0.05 --body path/ke/prompt.txt --media path/ke/clip.mp4
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalListingMessage } from "../src/catalog/listing.ts";
import { computeContentHash } from "../src/catalog/hash.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return process.argv[i + 1]!;
}

const api = arg("api").replace(/\/$/, "");
const title = arg("title");
const category = arg("category");
const priceUsdc = arg("price");
const bodyPath = arg("body");
const mediaPath = arg("media");

const key = process.env.CREATOR_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("CREATOR_PRIVATE_KEY env is not a 0x 32-byte key");
  process.exit(1);
}
const account = privateKeyToAccount(key as `0x${string}`);

// USDC 6 desimal, tanpa float.
const [whole = "0", frac = ""] = priceUsdc.split(".");
if (frac.length > 6) throw new Error("price has more than 6 decimals");
const priceAtomic = (BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6))).toString();

const body = readFileSync(resolve(bodyPath), "utf8");
const mediaBytes = readFileSync(resolve(mediaPath));
const ext = mediaPath.split(".").pop()!.toLowerCase();
const mime =
  ext === "mp4" ? "video/mp4"
  : ext === "webm" ? "video/webm"
  : ext === "webp" ? "image/webp"
  : ext === "png" ? "image/png"
  : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
  : null;
if (!mime) throw new Error(`unsupported media extension: ${ext}`);

// Hash lokal (aturan terpublikasi) dicek silang dengan /prepare milik server:
// beda berarti drift protokol — berhenti sebelum tanda tangan.
const localHash = computeContentHash(body);
const prepareRes = await fetch(`${api}/v1/listings/prepare`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body }),
});
const prepared = (await prepareRes.json()) as { contentHash?: string; error?: string; message?: string };
if (!prepareRes.ok || !prepared.contentHash) {
  console.error(`prepare failed [${prepareRes.status}]:`, JSON.stringify(prepared));
  process.exit(1);
}
if (prepared.contentHash !== localHash) {
  console.error(`hash drift: server ${prepared.contentHash} vs local ${localHash}`);
  process.exit(1);
}

const nonce = crypto.randomUUID().replaceAll("-", "");
const message = canonicalListingMessage({
  title,
  category,
  contentHash: prepared.contentHash,
  priceAtomic,
  nonce,
});
const signature = await account.signMessage({ message });

const form = new FormData();
form.set("title", title);
form.set("category", category);
form.set("body", body);
form.set("priceAtomic", priceAtomic);
form.set("nonce", nonce);
form.set("creatorAddress", account.address);
form.set("signature", signature);
form.set("media", new File([mediaBytes], basename(mediaPath), { type: mime }));

const res = await fetch(`${api}/v1/listings`, { method: "POST", body: form });
const json = await res.json();
console.log(`[${res.status}]`, JSON.stringify(json, null, 2));
process.exit(res.ok ? 0 : 1);
