# Promit — Arsitektur

> Pay-per-prompt marketplace di atas x402 (Base Sepolia + USDC).
> Manusia maupun **AI agent** bisa beli satu prompt seharga ~$0.05 tanpa langganan,
> tanpa akun, tanpa kartu kredit, tanpa API key.

Status dokumen: hasil riset + keputusan arsitektur, 7 Agustus 2026.
Semua angka teknis di bawah sudah diverifikasi langsung (on-chain / npm registry / HTTP), bukan dari ingatan.

---

## 1. Masalah yang dipecahkan

MotionSites menjual akses ke katalog prompt seharga **$300+ lifetime**. Kalau kamu cuma butuh
satu prompt, kamu tetap bayar $300. Tidak ada jalur "bayar sekali pakai".

Alasannya bukan karena mereka jahat — memang **tidak ada rel pembayaran** yang masuk akal
untuk transaksi $0.05. Stripe memungut ~$0.30 + 2,9% per transaksi, jadi biaya prosesnya
enam kali lipat harga barangnya. Micropayment mati bukan karena tidak ada permintaan,
tapi karena ongkos rel-nya.

x402 menghapus batasan itu: settlement USDC on-chain, ongkos gas di bawah $0.001,
final dalam hitungan detik, dan pembeli tidak perlu punya ETH sama sekali.

Konsekuensi yang lebih menarik: begitu satu prompt bisa dibeli lewat HTTP tanpa akun dan
tanpa API key, **agent bisa membelinya sendiri**. Itu pasar yang belum digarap MotionSites.

---

## 2. Temuan riset yang mengubah desain

### 2.1 x402 sudah v2 — hampir semua tutorial di internet sudah usang

Ini temuan paling penting. Ada dua generasi protokol yang sama-sama hidup:

| | v1 (legacy) | **v2 (yang kita pakai)** |
|---|---|---|
| Paket npm | `x402`, `x402-next`, `x402-fetch` — beku di **1.2.0**, deprecated | `@x402/core`, `@x402/evm`, `@x402/next`, `@x402/hono`, `@x402/fetch` — **2.21.0** |
| Header | `X-PAYMENT`, `X-PAYMENT-RESPONSE` | `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` |
| Network | `"base-sepolia"` | CAIP-2: `"eip155:84532"` |
| Field jumlah | `maxAmountRequired` | `amount` |
| Harga dinamis | tidak ada | **`price` boleh berupa function** |

Mencampur string v1 ke paket v2 gagal dengan `invalid_network`. Kalau nanti menemukan
tutorial yang memakai `X-PAYMENT` atau `"base-sepolia"`, itu v1 — jangan diikuti.

Harga dinamis per-resource baru ada di v2, dan itu justru fitur inti Promit
(tiap prompt punya harga sendiri). Jadi v2 bukan sekadar "versi lebih baru", tapi syarat.

### 2.2 Next.js 16 memakai `proxy.ts`, bukan `middleware.ts`

Next 16 mengganti nama konvensi middleware jadi proxy. Repo ini pakai Next **16.3.0**,
jadi paywall level-halaman ditulis di `proxy.ts` yang meng-export `proxy`, bukan
`middleware.ts`. Paket `@x402/next` 2.21.0 sudah menyesuaikan; `x402-next` 1.2.0 belum.

### 2.3 URL facilitator di README resmi salah

README paket v2 menulis `https://facilitator.x402.org`. Hostname itu **NXDOMAIN** —
tidak ada di DNS. Yang benar dan terbukti hidup:

```
https://x402.org/facilitator
```

Diverifikasi lewat `GET /supported`: mendukung `exact`, `upto`, dan `batch-settlement`
di `eip155:84532`, tanpa API key. Alamat signer facilitator: `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`.
Facilitator ini **testnet-only** — untuk mainnet nanti wajib pindah ke CDP (`@coinbase/x402`, butuh API key)
atau self-facilitate.

### 2.4 Paywall MotionSites bocor di sisi client

Saat tombol "copy prompt" diklik, **tidak ada satu pun network request**. Artinya seluruh
isi prompt library sudah ikut ter-download di bundle JavaScript sejak halaman pertama dibuka;
paywall $300 mereka murni gating tampilan.

Ini jadi aturan desain Promit yang tidak bisa ditawar: **teks prompt tidak pernah
menyeberang ke browser sebelum settlement terkonfirmasi**. Endpoint publik hanya
mengirim metadata (judul, kategori, video preview, teaser 1–2 baris). Isi lengkap
hanya keluar dari route ber-x402.

### 2.5 Stack MotionSites (hasil DevTools)

Vite SPA · Supabase (tabel `user_access`: `has_lifetime_access`, `plan`, `amount_paid`,
`stripe_session_id`, `owned_products`) · Stripe · Cloudflare R2 public bucket untuk video ·
sebagian Mux · ParityDeals untuk diskon regional.

---

## 3. Fakta terverifikasi (jangan diubah tanpa cek ulang)

### Base Sepolia

| Item | Nilai | Cara verifikasi |
|---|---|---|
| Chain ID | `84532` | `cast chain-id` |
| RPC | `https://sepolia.base.org` | — |
| Explorer | `https://sepolia.basescan.org` | — |

### USDC (dibaca langsung on-chain, bukan dari dokumentasi)

| Field | Nilai |
|---|---|
| Address | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `name()` | `"USDC"` |
| `decimals()` | `6` |
| `version()` | `"2"` |

EIP-3009 (`transferWithAuthorization`) tersedia → skema `exact` jalan langsung.

> **Jangan hardcode EIP-712 domain.** Di Base Sepolia `name` adalah `"USDC"`,
> tapi di Base **mainnet** `"USD Coin"`. Selalu baca dari `accepts[].extra`.
> Ini akan menggigit persis saat pindah ke mainnet kalau dilanggar.

Faucet: `https://faucet.circle.com` — 20 USDC per address per chain, tiap 2 jam.
Gas ETH: `https://portal.cdp.coinbase.com/products/faucet`.

### Toolchain smart contract (sudah terpasang & teruji di repo ini)

| Paket | Versi |
|---|---|
| Foundry | 1.7.1 |
| solc | 0.8.26 (dipin di `foundry.toml`) |
| forge-std | v1.16.2 |
| openzeppelin-contracts | v5.7.0 |
| openzeppelin-contracts-upgradeable | v5.7.0 |
| openzeppelin-foundry-upgrades | v0.4.2 |
| @openzeppelin/upgrades-core | 1.46.0 (via `npx`, butuh Node di PATH) |

---

## 4. Alur pembayaran

```
Browser / Agent                Promit API              Facilitator            Base Sepolia
     |                              |                       |                      |
     |-- GET /v1/prompts/:id ------>|                       |                      |
     |<-- 402 + PAYMENT-REQUIRED ---|                       |                      |
     |    (harga, payTo, asset,     |                       |                      |
     |     nonce window)            |                       |                      |
     |                              |                       |                      |
  [tanda tangan EIP-712             |                       |                      |
   TransferWithAuthorization —      |                       |                      |
   BUKAN transaksi, tanpa gas]      |                       |                      |
     |                              |                       |                      |
     |-- GET + PAYMENT-SIGNATURE -->|                       |                      |
     |                              |-- POST /verify ------>|                      |
     |                              |<-- isValid ───────────|                      |
     |                        [jalankan handler]            |                      |
     |                              |-- POST /settle ------>|                      |
     |                              |                       |-- transferWith...--->|
     |                              |<-- txHash ────────────|<─────────────────────|
     |<-- 200 + prompt              |                       |                      |
     |    + PAYMENT-RESPONSE(tx)    |                       |                      |
```

Yang membuat ini layak untuk agent: pembeli **hanya menandatangani pesan**, tidak
mengirim transaksi. Facilitator yang membayar gas. Jadi wallet agent cukup diisi USDC —
tidak perlu ETH sama sekali.

**Aturan penting:** perlakukan `settle.success === true` (ada txHash) sebagai satu-satunya
sumber kebenaran sebelum membuka prompt. Payload yang lolos `verify` masih bisa gagal
`settle` (saldo pindah di antara dua langkah).

---

## 5. Arsitektur repo

```
promit/
├── landingpage/     Next 16 — promit.xyz. Galeri + pitch + "copy prompt for agent"
├── frontend/        Next 16 — app.promit.xyz. Wallet, unlock, riwayat, dashboard kreator
├── backend/         Hono (bun) — api.promit.xyz. API ber-x402, MCP server, indexer
├── smartcontract/   Foundry — PromitRegistry (UUPS) di Base Sepolia
└── docs/
```

Kenapa backend terpisah dari Next API routes: karena **API-nya sendiri adalah produk**.
`api.promit.xyz` harus bisa dipanggil agent mana pun, dari runtime mana pun, tanpa
melewati frontend. Menaruhnya di Next route akan mengikat produk utama ke lifecycle
deployment UI.

### Pemilihan paket

| Layer | Paket | Alasan |
|---|---|---|
| Backend | `@x402/hono` + `@x402/core` + `@x402/evm` | bun-native, cepat, `price` boleh function |
| Frontend | `@x402/fetch` + `@x402/paywall` | signer cukup `{address, signTypedData}` → jembatan wagmi sepele |
| Next route (opsional) | `@x402/next` `withX402` | settle **hanya** kalau handler balas <400 |

Catatan penting soal timing settlement: `paymentMiddleware` (Hono/Express) menagih
**walaupun handler-mu 500**. Hanya `withX402` (Next) yang menunda settle sampai handler sukses.
Untuk Hono, pakai hook `onAfterSettle` atau alur manual kalau ini jadi masalah.

### CORS

Frontend (Vercel) memanggil backend beda origin, jadi wajib:

```
Access-Control-Allow-Headers:  PAYMENT-SIGNATURE
Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE
```

Tanpa `Expose-Headers`, browser **tidak bisa membaca** syarat pembayaran maupun txHash —
dan gejalanya membingungkan (request "sukses" tapi klien tidak tahu harus bayar berapa).

---

## 6. Smart contract

x402 sendiri **tidak butuh custom contract** — settlement memanggil USDC Circle langsung.
Jadi contract di sini harus punya alasan sendiri, bukan tempelan biar terlihat "web3".

Alasannya ada tiga, dan ketiganya nyata:

1. **Bagi hasil kreator.** x402 mengirim USDC ke satu alamat `payTo`. Kalau Promit mau
   jadi marketplace (kreator lain menjual prompt), pembagian pendapatan harus terjadi
   di suatu tempat yang bisa diaudit. Itu contract.
2. **Bukti kepemilikan yang portabel.** Pembeli dapat catatan on-chain bahwa dia sudah
   membuka prompt X — tidak bergantung pada database Promit tetap hidup.
3. **Keaslian prompt.** Menyimpan `keccak256(teks prompt)` on-chain berarti pembeli bisa
   membuktikan prompt yang dia terima persis yang dijanjikan, dan Promit tidak bisa
   diam-diam menukar isinya setelah dibeli.

### `PromitRegistry` (UUPS)

```
listPrompt(bytes32 contentHash, uint256 priceAtomic, string uri) -> promptId
recordUnlock(uint256 promptId, address buyer, uint256 amount, bytes32 paymentNonce)
claim()                       // kreator tarik saldo
setPlatformFeeBps(uint16)
```

- `payTo` di x402 diarahkan ke contract ini → USDC masuk langsung.
- Backend (role `SETTLER`) memanggil `recordUnlock` setelah facilitator konfirmasi settle.
- **Idempoten terhadap `paymentNonce`** — nonce EIP-3009 sudah unik dan sekali pakai,
  dipaksakan oleh contract USDC sendiri, jadi ini melindungi dari double-record kalau
  backend retry.

Kenapa UUPS dan bukan sekadar contract biasa: skema bagi hasil dan struktur fee hampir
pasti berubah setelah hackathon. Menaruhnya di balik proxy berarti alamat contract dan
riwayat unlock tetap valid saat logikanya berevolusi.

---

## 7. Lapisan agent (pembeda utama)

Ini bagian yang tidak dimiliki MotionSites dan yang paling kuat untuk track AI × Web3.

Tiga permukaan, satu API yang sama di belakangnya:

| Permukaan | Bentuk | Untuk siapa |
|---|---|---|
| **MCP server** | `@promit/mcp` — tools `search_prompts`, `preview_prompt`, `buy_prompt` | Claude Desktop, Claude Code, IDE apa pun ber-MCP |
| **Claude Code skill** | `promit` — agent tahu kapan harus cari & beli prompt | pengguna Claude Code |
| **CLI** | `npx promit buy <id>` / `promit search "fintech landing"` | siapa pun di terminal, CI |

Ketiganya membungkus `@x402/fetch` dengan signer dari private key wallet agent.
Wallet-nya cukup diisi USDC testnet — tidak perlu ETH, karena facilitator yang bayar gas.

Pagar pengaman yang wajib ada di ketiga permukaan (v2 menyediakannya langsung):

```ts
new x402Client().fromConfig({
  policies: [(v, reqs) => reqs.filter(r => BigInt(r.amount) <= MAX_PER_PROMPT)],
  onBeforePaymentCreation: hook,   // boleh membatalkan
})
```

Tanpa ini, sebuah endpoint jahat bisa meminta 402 dengan `amount` sangat besar dan
agent akan menandatanganinya tanpa bertanya. Batas per-prompt dan batas per-sesi
bukan fitur tambahan — itu syarat agar lapisan agent aman dirilis.

**Demo Day:** buka terminal, jalankan Claude Code, minta "bikin landing page fintech".
Agent mencari di Promit, menemukan prompt yang cocok, membayar $0.05 USDC sendiri,
menerima prompt, lalu membangun halamannya. Tunjukkan tx-nya di Basescan. Selesai.

---

## 8. Katalog konten

Setiap item butuh: preview (video/gif), judul, kategori, teaser, dan teks prompt lengkap.

### Konteks lisensi

MotionSites adalah **co-host resmi** hackathon ini (pengumuman @motionai, 29 Juli 2026),
memberi lifetime access ke semua peserta, dan **main track-nya berbunyi persis**:
*"How can builders resell prompts on motionsites.ai using x402?"*

Jadi mekanisme jual-ulang prompt lewat x402 memang yang diminta, bukan sekadar ditoleransi.

Yang tetap perlu diperhatikan — dan ini soal **strategi penilaian**, bukan legal:
diagram di pengumuman menggambarkan alur `Your Prompt → Price via x402 → List on
motionsites.ai → Marketplace → Users`. Track-nya membayangkan builder menjual prompt
**miliknya sendiri** lewat/di ekosistem MotionSites, bukan situs tandingan yang menjual
ulang katalog MotionSites. Posisi yang menjawab track secara langsung: Promit sebagai
**lapisan resale + pembayaran agent** — infrastruktur yang mengubah prompt apa pun
menjadi resource ber-x402, bukan pengganti marketplace-nya.

### Dataset seed

`backend/data/motionsites-free.json` — 23 item, **tier Free saja** (filter Pricing = Free;
prompt premium sengaja tidak diambil), diambil 7 Agustus 2026 dalam keadaan login
lifetime. 8 di antaranya punya preview `.mp4`, sisanya gif/webp. Total ~194 rb karakter prompt.

Item dengan video preview: Stillmind (Hero), TrustFlow (Finance), Celestial Renewal
(Wellness), Synth Mode (Fashion), Tech-Forward (Hero), 3D Portfolio (Portfolio),
Mostar Guide (Travel), PROMPT (Landing Page).

### Media: mirror, jangan hotlink

Video di-host di bucket publik Cloudflare R2 (`pub-86dc5b54...r2.dev`) dan terbukti
**terbuka tanpa proteksi referer** (dites dari `Referer` asing → semua HTTP 200,
total ~23 MB untuk 8 video).

Bisa di-hotlink bukan berarti sebaiknya di-hotlink. Salin ke R2/Vercel Blob sendiri:
kalau mereka merapikan bucket atau mengganti path, demo mati tanpa peringatan — dan
kemungkinan besar itu terjadi tepat saat kamu presentasi. Mirror sekali, ~23 MB, selesai.

### Konten orisinal tetap layak ditambahkan

Bukan karena wajib, tapi karena menghasilkan klaim yang tidak bisa ditiru: jalankan
prompt di Lovable/v0/Bolt, rekam hasilnya, host sendiri. Artinya tiap preview di Promit
adalah keluaran **asli** dari prompt yang dijual. Galeri MotionSites sendiri tidak
membuktikan itu. Untuk juri, "prompt ini terbukti bekerja" lebih kuat daripada
jumlah item di katalog.

MotionSites juga jadi **referensi UI/UX** — pola tata letak (grid video, filter pill,
hover-to-copy) bebas ditiru.

---

## 9. Catatan operasional yang sudah menggigit

Semua ini ditemukan saat menyiapkan repo ini, bukan teori:

- **`forge clean` sebelum deploy/upgrade/verify.** Tanpa itu, plugin OZ gagal dengan
  `Found multiple contracts with name ...` karena `build_info` basi. Sudah terjadi di sini.
- **`__UUPSUpgradeable_init()` tidak ada lagi di OZ v5.7.0.** File `UUPSUpgradeable.sol`
  di paket upgradeable hanya re-export dari paket biasa (tidak punya state, jadi sudah
  upgrade-safe). Memanggilnya = `Undeclared identifier`. Banyak tutorial masih menulisnya.
- **OZ v5 memakai ERC-7201 namespaced storage, bukan `__gap`.** Storage gap sudah tidak relevan.
- **`forge install repo@tag=vX` gagal di Foundry 1.7.1** walau tag-nya ada. Workaround
  yang dipakai: install tanpa tag, lalu `git checkout <tag>` di dalam tiap submodule.
- **Etherscan V2**: satu key dari **etherscan.io** melayani semua chain lewat
  `?chainid=84532`. Key lama terbitan basescan.org sudah mati.
- **`ffi = true` wajib** untuk validasi upgrade — dan itu keputusan kepercayaan
  (script bisa menjalankan shell). Untuk unit test murni tanpa ffi/Node, ada `UnsafeUpgrades`.
- **Dua paket OZ harus seversi.** `contracts` dan `contracts-upgradeable` dua-duanya v5.7.0.

---

## 10. Perintah deploy

```bash
export PRIVATE_KEY=0x...
export ETHERSCAN_API_KEY=...        # dari etherscan.io, BUKAN basescan.org

cd smartcontract
forge clean                          # wajib, lihat §9
forge script script/DeployPromitRegistry.s.sol \
  --rpc-url base_sepolia \
  --broadcast --verify \
  -vvvv
```

`--verify` mengirim implementation **dan** `ERC1967Proxy` sekaligus dari artefak broadcast.
Setelah itu, di Basescan buka halaman proxy → tab Contract → "More Options" →
**"Is this a proxy?"** → Verify, supaya tab Read/Write as Proxy muncul.

Alternatif tanpa API key sama sekali:

```bash
forge verify-contract <ADDR> src/PromitRegistry.sol:PromitRegistry \
  --verifier blockscout \
  --verifier-url https://base-sepolia.blockscout.com/api --watch
```

---

## 11. Yang masih terbuka

- **Positioning terhadap main track** (§8) — Promit sebagai lapisan resale/agent-payment
  untuk ekosistem MotionSites, atau situs berdiri sendiri. Ini memengaruhi penilaian.
- Mirror 8 video R2 (~23 MB) ke storage sendiri sebelum demo.
- Desain visual landing page — menunggu referensi.
- Apakah `landingpage` dan `frontend` tetap dua app terpisah atau digabung.
- Struktur `smartcontract` di repo utama masih git repo bersarang; di worktree ini sudah
  diperbaiki jadi submodule biasa yang terdaftar di root `.gitmodules`.

---

## 12. Temuan U15 — kontrak facilitator x402 yang teramati (live, 2026-08-07)

Semua di bawah ini diamati langsung dari `https://x402.org/facilitator` oleh
`scripts/spike-facilitator.ts` — bukan disalin dari dokumentasi. U4 ditulis
melawan kontrak ini. Infrastruktur: Vercel di belakang Cloudflare
(`x-vercel-id`, `cf-ray`); verifikasi internal memakai `viem@2.48.11` dan
mensimulasikan `transferWithAuthorization` lewat `eth_call`, bukan memulihkan
tanda tangan secara lokal — konsekuensinya ada di bagian error di bawah.

### Status yang terbukti dan yang belum

- **Terbukti:** bentuk wire v2, encoding EIP-712 (domain dari `extra`), dan
  pemulihan `payer` — `/verify` mengembalikan `payer` yang sama dengan alamat
  penandatangan dan menolak **hanya** karena saldo
  (`invalid_exact_evm_insufficient_balance`) pada kunci bersaldo 0. Otorisasi
  kedaluwarsa ditolak dengan error bernama.
- **BELUM terbukti: settle live** (butuh kunci ber-USDC). Wallet demo tetap:
  `0xadE939F26516c657fc01f2eD1B069562b672644c` (kuncinya di `.env`, tidak
  di-commit). Danai sekali di https://faucet.circle.com (Base Sepolia), lalu
  `bun run scripts/spike-facilitator.ts` dari root tanpa perubahan kode.

### Endpoint

| Endpoint | Metode | Fungsi |
|---|---|---|
| `/supported` | GET | daftar `kinds` + `extensions` + `signers` |
| `/verify` | POST | validasi payload tanpa on-chain write |
| `/settle` | POST | verifikasi ulang lalu kirim tx on-chain (facilitator bayar gas) |

`GET /supported` mengembalikan `{kinds, extensions, signers}`. Entri yang
Promit pakai: `{"x402Version":2,"scheme":"exact","network":"eip155:84532"}`
(tanpa `extra`). Signer EVM facilitator: `signers["eip155:*"] =
["0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf"]` — alamat inilah `sender` tx
settlement on-chain, berguna untuk mencocokkan event di Basescan.

### Bentuk request (identik untuk /verify dan /settle)

```jsonc
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { /* PaymentRequirements yang dipilih klien — sama seperti di bawah */ },
    "payload": {
      "signature": "0x…",                  // 65-byte ECDSA atas TransferWithAuthorization
      "authorization": {
        "from": "0x…", "to": "0x…",
        "value": "10000",                   // string desimal, atomic (6 desimal USDC)
        "validAfter": "0", "validBefore": "1786048422",  // string unix-seconds
        "nonce": "0x…"                      // bytes32 acak, sekali pakai per (from,nonce)
      }
    }
  },
  "paymentRequirements": {                  // peran server (U4 yang menyusun ini)
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "10000",
    "payTo": "0x…",
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USDC", "version": "2" }   // domain EIP-712 — WAJIB (lihat error)
  }
}
```

Catatan penting untuk U4:

- Nama field v2 adalah `accepted` (bukan `paymentRequirements` v1 di dalam
  payload) dan `amount` (bukan `maxAmountRequired` v1). Angka dikirim sebagai
  **string**, waktu sebagai string unix-seconds.
- Domain EIP-712 dibaca facilitator dari `paymentRequirements.extra.name/version`
  (terverifikasi on-chain: Base Sepolia USDC melaporkan `name='USDC'`,
  `version='2'` — beda dengan mainnet `USD Coin`). Tanpa `extra` →
  `invalid_exact_evm_missing_eip712_domain`.
- Tipe EIP-712: `TransferWithAuthorization(address from,address to,uint256
  value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`,
  `chainId` 84532, `verifyingContract` = alamat USDC.

### Bentuk respons

`POST /verify` — `{isValid, invalidReason?, invalidMessage?, payer?}`:

```json
{ "isValid": false,
  "invalidReason": "invalid_exact_evm_insufficient_balance",
  "payer": "0x9f09CeC811D1fBa47568Ea1397e4C1D0BD8B065F",
  "invalidMessage": "The contract function \"transferWithAuthorization\" reverted … ERC20: transfer amount exceeds balance …" }
```

`POST /settle` — `{success, errorReason?, errorMessage?, transaction, network, payer?}`;
saat gagal `transaction` adalah **string kosong**, bukan absen/null:

```json
{ "success": false, "errorReason": "invalid_exact_evm_insufficient_balance",
  "errorMessage": "…", "transaction": "", "network": "eip155:84532", "payer": "0x…" }
```

### Katalog error yang teramati

| Skenario | HTTP | Field pembeda |
|---|---|---|
| Body kosong / field hilang | **400** | verify: `invalidReason:"missing_parameters"`; settle: `errorReason:"missing_parameters"`, plus `network:"unknown:unknown"` |
| Skema tak terdaftar | **500** | `invalidReason:"unexpected_error"`, pesan `No facilitator registered for scheme: … and network: …` |
| Network tak terdaftar (mis. `eip155:1`) | **500** | sama seperti di atas |
| Otorisasi kedaluwarsa (`validBefore` lampau) | 200 | `invalid_exact_evm_payload_authorization_valid_before` |
| Saldo tidak cukup | 200 | `invalid_exact_evm_insufficient_balance` |
| `amount` requirements ≠ nilai yang ditandatangani | 200 | `invalid_exact_evm_payload_authorization_value_mismatch` |
| `extra` tanpa `name`/`version` | 200 | `invalid_exact_evm_missing_eip712_domain` |
| Tanda tangan rusak | 200 | **MENYESATKAN:** dilabel `invalid_exact_evm_insufficient_balance`; penyebab asli hanya terlihat di `invalidMessage` (`ECRecover: invalid signature 'v' value`) |

Implikasi untuk U4:

1. **Tangani tiga kelas HTTP:** 200 (hasil, sukses ataupun tolak), 400
   (request cacat), 500 (skema/network tak dikenal). Error 4xx/5xx tetap
   ber-body JSON dengan bentuk yang sama plus field `error` duplikat dari
   `invalidMessage`/`errorMessage`.
2. **Jangan cabangkan logika dari `invalid_exact_evm_insufficient_balance`
   saja** — label itu dipakai untuk *setiap* revert simulasi, termasuk tanda
   tangan rusak. Log `invalidMessage` untuk diagnosis; jangan tampilkan ke klien
   (bocor detail internal + versi viem facilitator).
3. **`/settle` memverifikasi ulang secara penuh** — verify-lalu-settle tidak
   atomik tapi settle sendiri aman dipanggil; kegagalan datang sebagai
   `success:false` bernama, bukan HTTP error.
4. **`payer` di respons gagal adalah klaim `authorization.from`**, bukan hasil
   pemulihan tanda tangan yang tervalidasi (terbukti dari kasus tanda tangan
   rusak yang tetap mengembalikan `payer`). Jangan pakai `payer` dari respons
   gagal untuk atribusi.
5. Latensi teramati: `/verify` ±300–700 ms, `/supported` ±200 ms (dari CGK;
   region Vercel `iad1`). Sediakan timeout ≥10 s untuk `/settle` karena ia
   menunggu inklusi tx.
