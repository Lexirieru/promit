# smartcontract/

PromitRegistry: UUPS implementation behind an ERC1967 proxy recording prompt listings and
settled unlocks. It never custodies funds (KTD3) — payments land in a plain wallet and the
backend settler writes records after settlement. Plan authority:
`docs/plans/2026-08-07-001-feat-promit-pay-per-prompt-marketplace-plan.md` (U8–U10).

## Layout

- `src/PromitRegistry.sol` — the implementation. `SETTLER_ROLE` (backend worker: writes
  listings and unlocks) is deliberately separate from `UPGRADER_ROLE` +
  `DEFAULT_ADMIN_ROLE` (upgrade authority, held outside the backend). Tests assert this
  separation; do not merge the roles for convenience.
- `src/PromitRegistryV2.sol` — upgrade fixture, inherits V1 so the layout is identical by
  construction. Target for U9's upgrade script. Carries `@custom:oz-upgrades-from`.
- `test/fixtures/PromitRegistryBadLayout.sol` — deliberately reordered storage. MUST stay
  under `test/` so it never enters the deployable source set.
- `test/PromitRegistry.t.sol` — behaviour; deploys `new PromitRegistry()` behind a raw
  `ERC1967Proxy` (fast, no ffi). `test/PromitRegistryUpgrade.t.sol` — validator and
  upgrade paths through `openzeppelin-foundry-upgrades` (ffi → `npx
  @openzeppelin/upgrades-core`, needs node; first run downloads the package).
- `script/DeployPromitRegistry.s.sol` — deploy U9 via `Upgrades.deployUUPSProxy`: proxy +
  initializer dalam satu transaksi. `SETTLER_ADDRESS` dan `UPGRADE_ADMIN_ADDRESS` dibaca
  dari env, dan script MENOLAK (error bernama, sebelum broadcast) bila settler, admin,
  atau deployer ada yang sama — jangan lemahkan guard ini demi kemudahan deploy.
- `script/UpgradePromitRegistry.s.sol` — pindahkan proxy ke V2. Pre-flight cek sender
  memegang `UPGRADER_ROLE` (broadcast dengan kunci upgrade admin, bukan deployer).
  Meng-import `PromitRegistryV2` hanya demi artefaknya ada di build-info (jebakan
  dynamic linking yang sama dengan fixture bad-layout). Runbook lengkap: `README.md`.

## Invariants the tests encode

- Unlock records key on `keccak256(abi.encode(payer, nonce))`, NEVER the raw nonce:
  EIP-3009 nonces are unique per payer only, so two payers may legitimately reuse a value.
- `recordUnlock` is a silent no-op on a repeat (payer, nonce) pair (AE5) — settler retries
  must not revert and must not overwrite the first record.
- An upgrade preserves listings, unlocks, roles, and the listing counter (AE6).

## Sharp edges learned building this

- OZ v5.7 upgradeable: `UUPSUpgradeable` is a stateless re-export of the vanilla contract.
  There is NO `__UUPSUpgradeable_init()` — calling it fails to compile. The implementation
  constructor calls `_disableInitializers()` behind `/// @custom:oz-upgrades-unsafe-allow
  constructor`.
- Always `forge clean` before test/deploy/verify runs that touch the upgrades plugin:
  stale `build_info` produces a duplicate-contract failure. `ffi`, `ast`, `build_info`,
  and `extra_output = ["storageLayout"]` in foundry.toml are all required by the plugin —
  removing any silently disables validation.
- Foundry 1.7 dynamic test linking only compiles files a test imports. The bad-layout
  fixture is imported by `PromitRegistryUpgrade.t.sol` purely so its artifact exists in
  `out/build-info` for the validator — keep that import when refactoring.
- upgrades-core refuses a contract as its own `referenceContract`, so an accept-side
  validateUpgrade control must use a genuinely different contract (V2 fills that role).
- Validator rejection reverts with a reason starting `Upgrade safety validation failed:`;
  an environment failure (npx/ffi broken) starts `Failed to run upgrade safety
  validation:`. The rejection test asserts the former so a broken validator cannot pass.
- In tests, reading a public constant like `registry.SETTLER_ROLE()` is an external call
  and consumes a pending `vm.prank` — read role constants into locals before pranking.
- `deployedBytecode` di artefak punya slot immutable berisi NOL. `UUPSUpgradeable.__self`
  adalah immutable, jadi implementasi yang di-graft ke node via `anvil_setCode` gagal
  `onlyProxy` dengan `UUPSUnauthorizedCallContext` — patch dulu offset di
  `deployedBytecode.immutableReferences` dengan alamat targetnya. Dipakai untuk gladi
  resik script upgrade tanpa broadcast (proxy sintetis di anvil, `forge script` simulasi).
- Sender default `forge script` tanpa kunci adalah
  `0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38`; guard pemisahan role membandingkan env
  dengan `msg.sender`, jadi simulasi tanpa kunci lolos selama alamat env berbeda darinya.

## Verification (U8 + U9 gates)

```
cd smartcontract && forge clean && forge test
cd smartcontract && forge fmt --check
# Simulasi deploy (tanpa --broadcast; alamat dummy harus berbeda satu sama lain):
cd smartcontract && forge clean && \
  SETTLER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  UPGRADE_ADMIN_ADDRESS=0x3C44CdDdB6a900fA2b585dd299e03d12FA4293BC \
  forge script script/DeployPromitRegistry.s.sol:DeployPromitRegistry --rpc-url base_sepolia
```

Deploy/verify/upgrade sungguhan (butuh kunci berdana ETH): runbook di `README.md`.
