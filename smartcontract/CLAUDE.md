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

## Verification (U8 gates)

```
cd smartcontract && forge clean && forge test
cd smartcontract && forge fmt --check
```
