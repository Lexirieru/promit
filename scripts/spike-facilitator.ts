/**
 * U15 — Facilitator settlement spike (throwaway).
 *
 * Membuktikan satu settlement skema `exact` (x402 v2) benar-benar selesai di
 * Base Sepolia lewat facilitator publik, SEBELUM U4/U6/U11/U12 dibangun di
 * atasnya. Menandatangani satu EIP-712 TransferWithAuthorization (ERC-3009)
 * lalu memanggil endpoint verify dan settle facilitator secara langsung dan
 * mencetak tx hash.
 *
 * Jalankan: bun run scripts/spike-facilitator.ts
 * Env:
 *   PROMIT_AGENT_PRIVATE_KEY  kunci pembayar (cukup USDC, tanpa ETH — gas
 *                             dibayar facilitator). Tanpa ini, skrip memakai
 *                             kunci ephemeral dan settlement TIDAK terbukti.
 *   PAY_TO_ADDRESS            penerima (default: alamat pembayar sendiri).
 *   FACILITATOR_URL           default https://x402.org/facilitator
 *                             (facilitator.x402.org di README resmi = NXDOMAIN).
 *
 * Temuan tercatat di docs/ARCHITECTURE.md — U4 ditulis melawan kontrak itu.
 */

import { createPublicClient, http, erc20Abi, getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const NETWORK = "eip155:84532";
const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const AMOUNT_ATOMIC = "10000"; // 0.01 USDC (6 desimal)
const MAX_TIMEOUT_SECONDS = 300;

const rpc = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function facilitator(path: string, body?: unknown) {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { unparseable: text.slice(0, 500) };
  }
  console.log(`${body === undefined ? "GET" : "POST"} ${path} -> HTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  return { status: res.status, json: json as Record<string, unknown> };
}

// --- 1. /supported: pastikan exact @ eip155:84532 diiklankan (v2) ---
section("GET /supported");
const supported = await facilitator("/supported");
const kinds = (supported.json.kinds ?? []) as Array<{
  x402Version: number;
  scheme: string;
  network: string;
}>;
const exactHere = kinds.some(
  (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === NETWORK,
);
if (!exactHere) {
  console.error(`FATAL: facilitator tidak mengiklankan exact v2 di ${NETWORK}`);
  process.exit(1);
}
console.log(`OK: exact (x402Version 2) tersedia di ${NETWORK}`);

// --- 2. Kunci pembayar (bun memuat .env dari cwd — jalankan dari root repo) ---
section("Payer");
const envKey = process.env.PROMIT_AGENT_PRIVATE_KEY;
if (!envKey || envKey.length <= 2) {
  console.error(
    "SPIKE_KEY_MISSING: PROMIT_AGENT_PRIVATE_KEY tidak di-set.\n" +
      "Buat .env di root repo berisi PROMIT_AGENT_PRIVATE_KEY=0x... (testnet-only, jangan commit),\n" +
      "lalu jalankan lagi: bun run scripts/spike-facilitator.ts",
  );
  process.exit(4);
}
const account = privateKeyToAccount(envKey as Hex);
const payTo = getAddress(process.env.PAY_TO_ADDRESS ?? account.address);
console.log(`payer : ${account.address}`);
console.log(`payTo : ${payTo}`);

const [balance, tokenName, tokenVersion] = await Promise.all([
  rpc.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  rpc.readContract({ address: USDC, abi: erc20Abi, functionName: "name" }),
  rpc.readContract({
    address: USDC,
    abi: [{ type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
    functionName: "version",
  }),
]);
console.log(`saldo USDC: ${balance} atomic; domain EIP-712 on-chain: name='${tokenName}' version='${tokenVersion}'`);

if (balance < BigInt(AMOUNT_ATOMIC)) {
  console.error(
    `SPIKE_PAYER_UNFUNDED: saldo USDC ${balance} atomic < ${AMOUNT_ATOMIC} atomic yang dibutuhkan.\n` +
      `Danai ${account.address} di https://faucet.circle.com (pilih Base Sepolia; ETH tidak perlu,\n` +
      `gas dibayar facilitator), lalu jalankan lagi tanpa perubahan apa pun.`,
  );
  process.exit(4);
}

// --- 3. PaymentRequirements: peran server. Domain EIP-712 masuk ke extra,
//        dan penandatanganan di bawah HANYA membaca dari extra (KTD18) ---
const requirements = {
  scheme: "exact",
  network: NETWORK,
  asset: USDC,
  amount: AMOUNT_ATOMIC,
  payTo,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  extra: { name: tokenName, version: tokenVersion },
};

async function signAuthorization(validAfter: bigint, validBefore: bigint) {
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex;
  const authorization = {
    from: account.address,
    to: requirements.payTo as Hex,
    value: requirements.amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };
  const signature = await account.signTypedData({
    domain: {
      name: requirements.extra.name, // dari extra, bukan konstanta (KTD18)
      version: requirements.extra.version,
      chainId: Number(requirements.network.split(":")[1]),
      verifyingContract: requirements.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to as Hex,
      value: BigInt(authorization.value),
      validAfter,
      validBefore,
      nonce,
    },
  });
  return { authorization, signature };
}

function wrap(payload: unknown) {
  // Bentuk wire v2: paymentPayload.accepted = requirements yang dipilih klien.
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload },
    paymentRequirements: requirements,
  };
}

const now = BigInt(Math.floor(Date.now() / 1000));

// --- 4. Tes negatif: otorisasi kedaluwarsa harus ditolak dengan error bernama ---
section("POST /verify — otorisasi kedaluwarsa (tes negatif)");
const expired = await signAuthorization(now - 7200n, now - 3600n);
const expiredVerify = await facilitator("/verify", wrap(expired));
if (expiredVerify.json.isValid === false && typeof expiredVerify.json.invalidReason === "string") {
  console.log(`OK: ditolak dengan invalidReason='${expiredVerify.json.invalidReason}'`);
} else {
  console.error("PERINGATAN: otorisasi kedaluwarsa TIDAK ditolak dengan error bernama");
}

// --- 5. Verify yang sebenarnya ---
section("POST /verify — otorisasi valid");
const live = await signAuthorization(0n, now + BigInt(MAX_TIMEOUT_SECONDS));
const verify = await facilitator("/verify", wrap(live));

if (verify.json.isValid !== true) {
  section("HASIL");
  console.log(`verify GAGAL: invalidReason='${verify.json.invalidReason}' — settle dilewati.`);
  console.log("Saldo cukup tapi verify tetap gagal — baca invalidMessage di atas.");
  process.exit(2);
}
console.log(`OK: isValid=true, payer=${verify.json.payer}`);

// --- 6. Settle: facilitator mengirim tx on-chain dan membayar gas ---
section("POST /settle");
const t0 = Date.now();
const settle = await facilitator("/settle", wrap(live));
console.log(`settle memakan ${Date.now() - t0} ms`);

if (settle.json.success !== true) {
  console.error(`settle GAGAL: errorReason='${settle.json.errorReason}'`);
  process.exit(3);
}

const txHash = settle.json.transaction as Hex;
section("HASIL");
console.log(`TX HASH : ${txHash}`);
console.log(`Explorer: https://sepolia.basescan.org/tx/${txHash}`);
const receipt = await rpc.waitForTransactionReceipt({ hash: txHash });
console.log(`Receipt : status=${receipt.status} block=${receipt.blockNumber}`);
process.exit(receipt.status === "success" ? 0 : 3);
