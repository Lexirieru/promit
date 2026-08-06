# PromitRegistry — deploy, verify, upgrade (Base Sepolia)

Registry UUPS di belakang proxy ERC1967 yang mencatat listing prompt dan unlock yang sudah
settle. Registry tidak pernah menyimpan dana: pembayaran mendarat di wallet biasa
(`PAY_TO_ADDRESS`), settler backend hanya menulis catatan. Detail kontrak dan invariannya ada
di [CLAUDE.md](./CLAUDE.md); otoritas rencana:
`docs/plans/2026-08-07-001-feat-promit-pay-per-prompt-marketplace-plan.md` (U8–U10).

## Prasyarat

- Foundry ≥ 1.7 dan Node.js: plugin `openzeppelin-foundry-upgrades` shell out ke
  `npx @openzeppelin/upgrades-core` (run pertama mengunduh paketnya).
- Salin `.env.example` di root repo menjadi `.env` dan isi:

| Variabel | Peran | Butuh ETH Base Sepolia? |
| --- | --- | --- |
| `PRIVATE_KEY` | deployer — mengirim transaksi deploy | Ya (deploy ±2,14 juta gas; ±0,000024 ETH pada 0,011 gwei) |
| `UPGRADE_ADMIN_ADDRESS` | pemegang `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE` | Ya, saat menjalankan upgrade (±1,9 juta gas) |
| `SETTLER_ADDRESS` | pemegang `SETTLER_ROLE` (worker backend, U10) | Ya, saat mulai mencatat unlock |
| `ETHERSCAN_API_KEY` | verifikasi source | Tidak |

Faucet: <https://portal.cdp.coinbase.com/products/faucet>.

**Ketiga alamat (deployer, upgrade admin, settler) WAJIB berbeda.** Script deploy menolak
jalan (error `RolesMustBeSeparate`, sebelum broadcast) jika ada yang sama — pemisahan role
adalah model keamanan registry: kunci backend yang bocor bisa menulis catatan tapi tidak bisa
menukar implementasi.

**Etherscan V2:** satu API key dari [etherscan.io](https://etherscan.io) melayani semua chain
lewat parameter `chainid` (sudah dikonfigurasi di `foundry.toml`, 84532 untuk Base Sepolia).
Key lama terbitan basescan.org tidak berfungsi lagi.

## Deploy + verify

```sh
cd smartcontract
set -a; source ../.env; set +a

# WAJIB sebelum setiap deploy/upgrade/verify: build_info basi membuat
# plugin upgrades gagal dengan error duplicate-contract.
forge clean

# Gladi resik — simulasi fork, tidak mengirim transaksi:
forge script script/DeployPromitRegistry.s.sol:DeployPromitRegistry --rpc-url base_sepolia

# Tembak + verifikasi implementation & proxy sekaligus:
forge script script/DeployPromitRegistry.s.sol:DeployPromitRegistry \
    --rpc-url base_sepolia \
    --private-key "$PRIVATE_KEY" \
    --broadcast --verify --slow
```

Script men-deploy lewat `Upgrades.deployUUPSProxy` sehingga proxy dan `initialize(upgradeAdmin,
settler)` mendarat dalam satu transaksi — tidak ada jendela proxy hidup tanpa role. `--verify`
memverifikasi kedua kontrak hasil broadcast (implementasi `PromitRegistry` dan `ERC1967Proxy`
beserta constructor args-nya). `--slow` menunggu tiap transaksi masuk blok sebelum mengirim
berikutnya, supaya urutan nonce aman di RPC publik.

Fallback kalau `--verify` gagal (mis. rate limit) — verifikasi manual per kontrak:

```sh
forge verify-contract <IMPL_ADDRESS> src/PromitRegistry.sol:PromitRegistry \
    --chain 84532 --etherscan-api-key "$ETHERSCAN_API_KEY" --watch

forge verify-contract <PROXY_ADDRESS> \
    lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy \
    --chain 84532 --etherscan-api-key "$ETHERSCAN_API_KEY" --watch \
    --constructor-args "$(cast abi-encode 'constructor(address,bytes)' <IMPL_ADDRESS> \
        "$(cast calldata 'initialize(address,address)' "$UPGRADE_ADMIN_ADDRESS" "$SETTLER_ADDRESS")")"
```

## Link proxy di Basescan

Setelah keduanya verified: buka `https://sepolia.basescan.org/address/<PROXY_ADDRESS>` → tab
**Contract** → **More Options** → **Is this a proxy?** → **Verify** → **Save**. Setelah itu tab
*Read/Write as Proxy* resolve ke ABI implementasi.

## Pasca-deploy

1. Isi `PROMIT_REGISTRY_ADDRESS=<PROXY_ADDRESS>` di `.env` root — dipakai backend (U10) dan
   script upgrade. `PAY_TO_ADDRESS` harus TETAP wallet biasa, bukan alamat proxy: registry
   tidak punya jalur penarikan dana.
2. Catat alamat di tabel [Alamat](#alamat-base-sepolia) di bawah.
3. Cek role dari luar (deployer TIDAK boleh memegang role apa pun):

```sh
cast call "$PROMIT_REGISTRY_ADDRESS" 'hasRole(bytes32,address)(bool)' \
    "$(cast keccak 'SETTLER_ROLE')" "$SETTLER_ADDRESS" --rpc-url base_sepolia      # true
cast call "$PROMIT_REGISTRY_ADDRESS" 'hasRole(bytes32,address)(bool)' \
    "$(cast keccak 'SETTLER_ROLE')" <DEPLOYER_ADDRESS> --rpc-url base_sepolia      # false
```

## Upgrade ke V2

Broadcast dengan kunci **upgrade admin** (pemegang `UPGRADER_ROLE`) — bukan kunci deployer
atau settler. Script menolak pre-flight (`SenderLacksUpgraderRole`) kalau sender salah, dan
sesudah upgrade memastikan `version()` mengembalikan `"2"` serta listing counter tidak berubah.

```sh
forge clean
forge script script/UpgradePromitRegistry.s.sol:UpgradePromitRegistry \
    --rpc-url base_sepolia \
    --private-key "$UPGRADE_ADMIN_PRIVATE_KEY" \
    --broadcast --verify --slow
```

## Alamat (Base Sepolia)

| Kontrak | Alamat |
| --- | --- |
| Proxy (`PROMIT_REGISTRY_ADDRESS`) | _belum deploy — isi setelah U9 broadcast_ |
| Implementation V1 (`PromitRegistry`) | _belum deploy_ |
| Implementation V2 (`PromitRegistryV2`) | _belum upgrade_ |

## Pengembangan

```sh
forge clean && forge test   # 22 tes; butuh node untuk validator ffi
forge fmt --check
```
