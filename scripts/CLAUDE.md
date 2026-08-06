# scripts/

Spike sekali pakai (U15). Bukan bagian dari workspace bun — direktori ini punya
`package.json` sendiri supaya `bun run scripts/spike-facilitator.ts` tetap jalan
setelah root workspace (U16) dibuat tanpa memasukkan `scripts/`.

## spike-facilitator.ts

Membuktikan settlement x402 `exact` v2 di Base Sepolia lewat
`https://x402.org/facilitator` (JANGAN pakai `facilitator.x402.org` — NXDOMAIN).

- Jalankan **dari root repo** (`bun run scripts/spike-facilitator.ts`) — bun
  memuat `.env` dari cwd, dan kuncinya ada di `.env` root (gitignored).
- Wallet demo tetap: `0xadE939F26516c657fc01f2eD1B069562b672644c`. Saldo nol →
  keluar dengan `SPIKE_PAYER_UNFUNDED` (exit 4) + instruksi faucet
  (https://faucet.circle.com, Base Sepolia; ETH tidak perlu — facilitator yang
  bayar gas). Setelah didanai, jalankan ulang tanpa perubahan kode.
- Exit code: 0 settle sukses + receipt `success`; 2 verify ditolak; 3 settle
  gagal; 4 kunci hilang/saldo kosong; 1 `/supported` tidak mengiklankan
  `exact` di `eip155:84532`.

Kontrak facilitator hasil observasi (nama field, katalog error, jebakan
`invalid_exact_evm_insufficient_balance` yang menyesatkan) terdokumentasi di
`docs/ARCHITECTURE.md` §12 — U4 ditulis melawan kontrak itu, baca dulu sebelum
menyentuh kode pembayaran.
