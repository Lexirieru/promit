// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PromitRegistry} from "../src/PromitRegistry.sol";

contract PromitRegistryTest is Test {
    PromitRegistry internal implementation;
    PromitRegistry internal registry;

    address internal upgradeAdmin = makeAddr("upgradeAdmin");
    address internal settler = makeAddr("settler");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");
    address internal payerA = makeAddr("payerA");
    address internal payerB = makeAddr("payerB");

    bytes32 internal constant CONTENT_HASH = keccak256("prompt body under published rule");
    bytes32 internal constant NONCE = keccak256("eip-3009 nonce");
    uint256 internal constant PRICE = 90_000; // 0.09 USDC in atomic units
    string internal constant METADATA_URI = "https://promit.example/api/prompts/1";

    function setUp() public {
        implementation = new PromitRegistry();
        registry = PromitRegistry(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(PromitRegistry.initialize, (upgradeAdmin, settler))
                )
            )
        );
    }

    function _registerDefaultListing() internal returns (uint256) {
        vm.prank(settler);
        return registry.registerListing(creator, CONTENT_HASH, PRICE, METADATA_URI);
    }

    // --- listings ---

    function test_RegisterListingStoresFieldsAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit PromitRegistry.ListingRegistered(1, creator, CONTENT_HASH, PRICE, METADATA_URI);
        uint256 id = _registerDefaultListing();

        assertEq(id, 1);
        assertEq(registry.listingCount(), 1);
        PromitRegistry.Listing memory listing = registry.getListing(id);
        assertEq(listing.creator, creator);
        assertEq(listing.contentHash, CONTENT_HASH);
        assertEq(listing.price, PRICE);
        assertTrue(listing.active);
        assertEq(listing.metadataURI, METADATA_URI);
    }

    function test_RegisterListingZeroContentHashReverts() public {
        vm.prank(settler);
        vm.expectRevert(PromitRegistry.ZeroContentHash.selector);
        registry.registerListing(creator, bytes32(0), PRICE, METADATA_URI);
    }

    function test_RegisterListingZeroPriceReverts() public {
        vm.prank(settler);
        vm.expectRevert(PromitRegistry.ZeroPrice.selector);
        registry.registerListing(creator, CONTENT_HASH, 0, METADATA_URI);
    }

    function test_RegisterListingZeroCreatorReverts() public {
        vm.prank(settler);
        vm.expectRevert(PromitRegistry.ZeroAddress.selector);
        registry.registerListing(address(0), CONTENT_HASH, PRICE, METADATA_URI);
    }

    function test_RegisterListingWithoutSettlerRoleReverts() public {
        bytes32 settlerRole = registry.SETTLER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, settlerRole
            )
        );
        vm.prank(stranger);
        registry.registerListing(creator, CONTENT_HASH, PRICE, METADATA_URI);
    }

    function test_SetListingActiveTogglesAndEmits() public {
        uint256 id = _registerDefaultListing();

        vm.expectEmit(true, false, false, true);
        emit PromitRegistry.ListingActiveSet(id, false);
        vm.prank(settler);
        registry.setListingActive(id, false);
        assertFalse(registry.getListing(id).active);
    }

    function test_GetListingUnknownIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(PromitRegistry.UnknownListing.selector, 1));
        registry.getListing(1);
    }

    // --- unlocks ---

    function test_RecordUnlockStoresFieldsAndEmits() public {
        uint256 id = _registerDefaultListing();
        bytes32 key = registry.unlockKey(payerA, NONCE);

        vm.warp(1_754_500_000);
        vm.expectEmit(true, true, true, true);
        emit PromitRegistry.UnlockRecorded(key, payerA, NONCE, id, PRICE);
        vm.prank(settler);
        registry.recordUnlock(payerA, NONCE, id, PRICE);

        assertTrue(registry.isUnlocked(payerA, NONCE));
        PromitRegistry.Unlock memory unlock = registry.getUnlock(payerA, NONCE);
        assertEq(unlock.payer, payerA);
        assertEq(unlock.nonce, NONCE);
        assertEq(unlock.listingId, id);
        assertEq(unlock.amount, PRICE);
        assertEq(unlock.recordedAt, 1_754_500_000);
    }

    /// Covers AE5: the settler retrying the same (payer, nonce) pair must not revert and
    /// must leave exactly one record. The retry deliberately passes different values —
    /// if it overwrote, the assertions on the first write's fields would catch it.
    function test_RecordUnlockSamePayerAndNonceTwiceIsIdempotent() public {
        uint256 id = _registerDefaultListing();
        vm.warp(1_754_500_000);
        vm.prank(settler);
        registry.recordUnlock(payerA, NONCE, id, PRICE);

        uint256 secondId = _registerDefaultListing();
        vm.warp(1_754_600_000);
        vm.recordLogs();
        vm.prank(settler);
        registry.recordUnlock(payerA, NONCE, secondId, PRICE + 1);

        assertEq(vm.getRecordedLogs().length, 0, "retry must not emit a second event");
        PromitRegistry.Unlock memory unlock = registry.getUnlock(payerA, NONCE);
        assertEq(unlock.listingId, id, "retry must not overwrite the first record");
        assertEq(unlock.amount, PRICE);
        assertEq(unlock.recordedAt, 1_754_500_000);
    }

    /// EIP-3009 nonces are only unique per payer: the same nonce value from two payers is
    /// legitimate and must produce two distinct records, which is why the key is
    /// keccak256(abi.encode(payer, nonce)) and never the raw nonce.
    function test_RecordUnlockSameNonceDifferentPayersAreDistinct() public {
        uint256 id = _registerDefaultListing();
        vm.startPrank(settler);
        registry.recordUnlock(payerA, NONCE, id, PRICE);
        registry.recordUnlock(payerB, NONCE, id, PRICE);
        vm.stopPrank();

        assertTrue(registry.isUnlocked(payerA, NONCE));
        assertTrue(registry.isUnlocked(payerB, NONCE));
        assertNotEq(registry.unlockKey(payerA, NONCE), registry.unlockKey(payerB, NONCE));
        assertEq(registry.getUnlock(payerA, NONCE).payer, payerA);
        assertEq(registry.getUnlock(payerB, NONCE).payer, payerB);
    }

    function test_RecordUnlockWithoutSettlerRoleReverts() public {
        uint256 id = _registerDefaultListing();
        bytes32 settlerRole = registry.SETTLER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, settlerRole
            )
        );
        vm.prank(stranger);
        registry.recordUnlock(payerA, NONCE, id, PRICE);
    }

    function test_RecordUnlockUnknownListingReverts() public {
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(PromitRegistry.UnknownListing.selector, 7));
        registry.recordUnlock(payerA, NONCE, 7, PRICE);
    }

    // --- roles and upgrade authority ---

    function test_RolesAreSeparated() public view {
        assertTrue(registry.hasRole(registry.UPGRADER_ROLE(), upgradeAdmin));
        assertTrue(registry.hasRole(registry.SETTLER_ROLE(), settler));
        assertFalse(registry.hasRole(registry.SETTLER_ROLE(), upgradeAdmin));
        assertFalse(registry.hasRole(registry.UPGRADER_ROLE(), settler));
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), settler));
    }

    /// The settler is the backend's key; a backend compromise must not be able to swap
    /// the implementation. Authorization is checked before the new implementation is,
    /// so an arbitrary address suffices here.
    function test_UpgradeFromSettlerReverts() public {
        bytes32 upgraderRole = registry.UPGRADER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, settler, upgraderRole
            )
        );
        vm.prank(settler);
        UUPSUpgradeable(address(registry)).upgradeToAndCall(address(0xdead), "");
    }

    function test_UpgradeFromStrangerReverts() public {
        bytes32 upgraderRole = registry.UPGRADER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, upgraderRole
            )
        );
        vm.prank(stranger);
        UUPSUpgradeable(address(registry)).upgradeToAndCall(address(0xdead), "");
    }

    function test_UpgradeAuthorityCanUpgrade() public {
        address newImplementation = address(new PromitRegistry());
        vm.prank(upgradeAdmin);
        UUPSUpgradeable(address(registry)).upgradeToAndCall(newImplementation, "");
    }

    // --- initialization ---

    function test_ImplementationCannotBeInitializedDirectly() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(upgradeAdmin, settler);
    }

    function test_ProxyCannotBeInitializedTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(upgradeAdmin, settler);
    }

    function test_InitializeZeroAddressReverts() public {
        PromitRegistry freshImplementation = new PromitRegistry();
        vm.expectRevert(PromitRegistry.ZeroAddress.selector);
        new ERC1967Proxy(
            address(freshImplementation),
            abi.encodeCall(PromitRegistry.initialize, (address(0), settler))
        );
    }
}
