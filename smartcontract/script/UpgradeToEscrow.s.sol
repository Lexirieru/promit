// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {PromitRegistry} from "../src/PromitRegistry.sol";
// Di-import demi artefaknya ada di out/build-info: Foundry 1.7 hanya meng-compile file
// yang di-import, dan Upgrades.upgradeProxy mencari artefak V3 lewat nama string.
import {PromitRegistryV3} from "../src/PromitRegistryV3.sol";

/// @title UpgradeToEscrow
/// @notice Pindahkan proxy ke PromitRegistryV3 dan namai token payout dalam satu jalan.
///
/// @dev Proxy TIDAK berpindah alamat dan tidak ada deploy ulang: yang di-deploy hanya
///      implementasi baru, lalu proxy diarahkan ke sana. Listing, unlock, role, dan
///      counter tetap utuh — dua require di bawah membuktikannya terhadap chain, bukan
///      terhadap asumsi.
///
///      Broadcast dengan kunci UPGRADE_ADMIN, bukan deployer atau settler: hanya pemegang
///      UPGRADER_ROLE yang lolos _authorizeUpgrade. Jalankan `forge clean` dulu.
///
///      Env: PROMIT_REGISTRY_ADDRESS, PAYOUT_TOKEN_ADDRESS (USDC Base Sepolia
///      0x036CbD53842c5426634e7929541eC2318f3dCF7e).
contract UpgradeToEscrow is Script {
    error SenderLacksUpgraderRole(address sender);
    error PayoutTokenHasNoCode(address token);

    function run() external returns (address newImplementation) {
        address proxy = vm.envAddress("PROMIT_REGISTRY_ADDRESS");
        address payoutToken = vm.envAddress("PAYOUT_TOKEN_ADDRESS");
        PromitRegistry registry = PromitRegistry(proxy);

        // Pre-flight, sebelum gas terbakar. Sebuah alamat token yang salah ketik akan
        // terkunci PERMANEN: setPayoutToken hanya boleh sekali, jadi memeriksa ada
        // kodenya di sana jauh lebih murah daripada menemukannya sesudahnya.
        if (payoutToken.code.length == 0) revert PayoutTokenHasNoCode(payoutToken);

        bytes32 upgraderRole = registry.UPGRADER_ROLE();
        if (!registry.hasRole(upgraderRole, msg.sender)) {
            revert SenderLacksUpgraderRole(msg.sender);
        }

        uint256 listingCountBefore = registry.listingCount();

        vm.startBroadcast();
        Upgrades.upgradeProxy(proxy, "PromitRegistryV3.sol", "");
        // Dipanggil di broadcast yang sama supaya tidak pernah ada jendela di mana proxy
        // sudah bisa menerima uang tapi belum tahu token apa yang harus dibayarkan.
        PromitRegistryV3(proxy).setPayoutToken(payoutToken);
        vm.stopBroadcast();

        newImplementation = Upgrades.getImplementationAddress(proxy);

        require(
            keccak256(bytes(PromitRegistryV3(proxy).version())) == keccak256(bytes("3")),
            "proxy masih menjalankan kode lama"
        );
        require(
            registry.listingCount() == listingCountBefore, "listing counter berubah saat upgrade"
        );
        require(
            address(PromitRegistryV3(proxy).payoutToken()) == payoutToken, "payout token tidak set"
        );

        console.log("PromitRegistry proxy (tidak berubah):", proxy);
        console.log("Implementation baru (V3):", newImplementation);
        console.log("Payout token:", payoutToken);
        console.log("Arahkan PAY_TO_ADDRESS ke proxy di atas agar pembayaran masuk escrow.");
    }
}
