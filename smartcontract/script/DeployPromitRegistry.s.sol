// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {PromitRegistry} from "../src/PromitRegistry.sol";

/// @title DeployPromitRegistry
/// @notice Deploy PromitRegistry (implementasi UUPS) di belakang proxy ERC1967 lewat helper
///         openzeppelin-foundry-upgrades, sehingga proxy dan initializer-nya mendarat dalam
///         satu transaksi — tidak ada jendela di mana proxy hidup tanpa role terpasang.
/// @dev SETTLER_ADDRESS dan UPGRADE_ADMIN_ADDRESS WAJIB dari env, bukan dari msg.sender:
///      tanpa itu U10 revert di tulisan pertama, dan "perbaikan" tercepat yang akan diambil
///      orang adalah memakai ulang kunci deployer — persis pemisahan role yang mau dijaga.
///      Jalankan `forge clean` sebelum script ini: build_info basi membuat plugin upgrades
///      gagal dengan error duplicate-contract.
contract DeployPromitRegistry is Script {
    /// @dev Pemisahan role adalah inti desain (lihat smartcontract/CLAUDE.md). Ditolak di
    ///      sini, sebelum broadcast, supaya salah konfigurasi env tidak membakar gas.
    error RolesMustBeSeparate(string reason);

    function run() external returns (address proxy, address implementation) {
        address upgradeAdmin = vm.envAddress("UPGRADE_ADMIN_ADDRESS");
        address settler = vm.envAddress("SETTLER_ADDRESS");
        // Di forge script, msg.sender pada titik ini = akun yang akan broadcast
        // (turunan --private-key / --sender; DEFAULT_SENDER saat simulasi tanpa kunci).
        address deployer = msg.sender;

        if (settler == upgradeAdmin) {
            revert RolesMustBeSeparate("SETTLER_ADDRESS == UPGRADE_ADMIN_ADDRESS");
        }
        if (settler == deployer) {
            revert RolesMustBeSeparate("SETTLER_ADDRESS == deployer");
        }
        if (upgradeAdmin == deployer) {
            revert RolesMustBeSeparate("UPGRADE_ADMIN_ADDRESS == deployer");
        }

        vm.startBroadcast();
        proxy = Upgrades.deployUUPSProxy(
            "PromitRegistry.sol", abi.encodeCall(PromitRegistry.initialize, (upgradeAdmin, settler))
        );
        vm.stopBroadcast();

        implementation = Upgrades.getImplementationAddress(proxy);

        // Post-condition dievaluasi juga saat simulasi fork, jadi salah pasang role
        // ketahuan sebelum ada transaksi sungguhan.
        PromitRegistry registry = PromitRegistry(proxy);
        bytes32 settlerRole = registry.SETTLER_ROLE();
        bytes32 upgraderRole = registry.UPGRADER_ROLE();
        require(registry.hasRole(settlerRole, settler), "settler tidak memegang SETTLER_ROLE");
        require(registry.hasRole(upgraderRole, upgradeAdmin), "admin tidak memegang UPGRADER_ROLE");
        require(!registry.hasRole(settlerRole, deployer), "deployer memegang SETTLER_ROLE");
        require(!registry.hasRole(upgraderRole, deployer), "deployer memegang UPGRADER_ROLE");

        console.log("PromitRegistry proxy (PROMIT_REGISTRY_ADDRESS):", proxy);
        console.log("PromitRegistry implementation:", implementation);
        console.log("SETTLER_ROLE  ->", settler);
        console.log("UPGRADER_ROLE ->", upgradeAdmin);
    }
}
