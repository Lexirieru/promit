// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {PromitRegistry} from "../src/PromitRegistry.sol";
// Import V2 juga demi kompilasi: Foundry 1.7 hanya meng-compile file yang di-import,
// dan Upgrades.upgradeProxy mencari artefak V2 (plus anotasi @custom:oz-upgrades-from)
// di out/build-info lewat nama string. Tanpa import ini artefaknya bisa tidak ada.
import {PromitRegistryV2} from "../src/PromitRegistryV2.sol";

/// @title UpgradePromitRegistry
/// @notice Pindahkan proxy PromitRegistry ke PromitRegistryV2 lewat helper
///         openzeppelin-foundry-upgrades, yang menjalankan validator upgrade-safety
///         (layout storage) sebelum menyentuh chain.
/// @dev Broadcast dengan kunci UPGRADE_ADMIN, BUKAN kunci deployer atau settler —
///      hanya pemegang UPGRADER_ROLE yang lolos _authorizeUpgrade. Jalankan
///      `forge clean` dulu: build_info basi membuat validator gagal duplicate-contract.
contract UpgradePromitRegistry is Script {
    error SenderLacksUpgraderRole(address sender);

    function run() external returns (address newImplementation) {
        address proxy = vm.envAddress("PROMIT_REGISTRY_ADDRESS");
        PromitRegistry registry = PromitRegistry(proxy);

        // Pre-flight: gagal dengan error bernama sebelum broadcast, bukan revert
        // AccessControl di tengah transaksi yang sudah membayar gas.
        bytes32 upgraderRole = registry.UPGRADER_ROLE();
        if (!registry.hasRole(upgraderRole, msg.sender)) {
            revert SenderLacksUpgraderRole(msg.sender);
        }

        uint256 listingCountBefore = registry.listingCount();

        vm.startBroadcast();
        Upgrades.upgradeProxy(proxy, "PromitRegistryV2.sol", "");
        vm.stopBroadcast();

        newImplementation = Upgrades.getImplementationAddress(proxy);

        // V1 tidak punya version(); panggilan yang berhasil membuktikan proxy sudah
        // mengeksekusi kode baru. Counter yang tak berubah membuktikan state selamat (AE6).
        require(
            keccak256(bytes(PromitRegistryV2(proxy).version())) == keccak256(bytes("2")),
            "proxy masih menjalankan kode lama"
        );
        require(
            registry.listingCount() == listingCountBefore, "listing counter berubah saat upgrade"
        );

        console.log("PromitRegistry proxy:", proxy);
        console.log("Implementation baru (V2):", newImplementation);
    }
}
