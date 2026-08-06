// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Options} from "openzeppelin-foundry-upgrades/Options.sol";
import {PromitRegistry} from "../src/PromitRegistry.sol";
import {PromitRegistryV2} from "../src/PromitRegistryV2.sol";
// Imported for compilation only: Foundry's dynamic test linking skips files no test
// imports, and the validator can only reject an artifact that exists in out/build-info.
import {PromitRegistryBadLayout} from "./fixtures/PromitRegistryBadLayout.sol";

/// @dev Upgrades.* are internal library functions, so their reverts cannot be caught with
///      try/catch from the test contract directly. This wrapper turns them into external
///      calls, the same pattern openzeppelin-foundry-upgrades uses in its own test suite.
contract ValidationInvoker {
    function validateUpgrade(string memory contractName, Options memory opts) external {
        Upgrades.validateUpgrade(contractName, opts);
    }

    function validateImplementation(string memory contractName, Options memory opts) external {
        Upgrades.validateImplementation(contractName, opts);
    }
}

contract PromitRegistryUpgradeTest is Test {
    string internal constant V1 = "PromitRegistry.sol:PromitRegistry";
    string internal constant V2 = "PromitRegistryV2.sol:PromitRegistryV2";
    string internal constant BAD = "PromitRegistryBadLayout.sol:PromitRegistryBadLayout";

    address internal upgradeAdmin = makeAddr("upgradeAdmin");
    address internal settler = makeAddr("settler");
    address internal creator = makeAddr("creator");
    address internal payer = makeAddr("payer");

    bytes32 internal constant CONTENT_HASH = keccak256("prompt body under published rule");
    bytes32 internal constant NONCE = keccak256("eip-3009 nonce");

    ValidationInvoker internal invoker;

    function setUp() public {
        invoker = new ValidationInvoker();
    }

    /// The core safety claim of U8: a reordered storage layout is REJECTED, not silently
    /// accepted. The revert reason must be the validator's rejection message — a reason
    /// starting with "Failed to run upgrade safety validation" would mean the validator
    /// never ran (broken ffi/npx), which this test must not count as a pass.
    /// (upgrades-core refuses a contract as its own reference, so the accept-side control
    /// for validateUpgrade is the V2 upgrade test, not a V1-against-V1 validation here.)
    function test_ValidatorRejectsReorderedStorageLayout() public {
        Options memory opts;
        opts.referenceContract = V1;
        try invoker.validateUpgrade(BAD, opts) {
            fail("upgrade-safety validator accepted a reordered storage layout");
        } catch Error(string memory reason) {
            assertTrue(
                vm.contains(reason, "Upgrade safety validation failed"),
                string.concat("validator did not run to a rejection; got: ", reason)
            );
        }
    }

    /// Control: the implementation itself passes the safety checks through the same
    /// ffi/npx machinery the rejection test uses, so a broken environment fails here too.
    function test_ValidatorAcceptsImplementation() public {
        Options memory opts;
        invoker.validateImplementation(V1, opts);
    }

    /// Covers AE6: everything written before the upgrade reads back unchanged after it,
    /// and the registry keeps working — the listing counter continues where it left off.
    /// Upgrades.upgradeProxy also runs the validator against V2's @custom:oz-upgrades-from
    /// annotation, which is the accept-side control for the rejection test above.
    function test_UpgradePreservesListingsAndUnlocks() public {
        address proxy = Upgrades.deployUUPSProxy(
            "PromitRegistry.sol", abi.encodeCall(PromitRegistry.initialize, (upgradeAdmin, settler))
        );
        PromitRegistry registry = PromitRegistry(proxy);

        vm.warp(1_754_500_000);
        vm.startPrank(settler);
        uint256 listingId =
            registry.registerListing(creator, CONTENT_HASH, 90_000, "https://promit.example/1");
        registry.recordUnlock(payer, NONCE, listingId, 90_000);
        vm.stopPrank();

        vm.startPrank(upgradeAdmin);
        Upgrades.upgradeProxy(proxy, "PromitRegistryV2.sol", "");
        vm.stopPrank();

        assertEq(PromitRegistryV2(proxy).version(), "2", "proxy still runs the old code");

        PromitRegistry.Listing memory listing = registry.getListing(listingId);
        assertEq(listing.creator, creator);
        assertEq(listing.contentHash, CONTENT_HASH);
        assertEq(listing.price, 90_000);
        assertTrue(listing.active);
        assertEq(listing.metadataURI, "https://promit.example/1");

        PromitRegistry.Unlock memory unlock = registry.getUnlock(payer, NONCE);
        assertEq(unlock.payer, payer);
        assertEq(unlock.nonce, NONCE);
        assertEq(unlock.listingId, listingId);
        assertEq(unlock.amount, 90_000);
        assertEq(unlock.recordedAt, 1_754_500_000);

        assertTrue(registry.hasRole(registry.SETTLER_ROLE(), settler));
        assertTrue(registry.hasRole(registry.UPGRADER_ROLE(), upgradeAdmin));

        vm.prank(settler);
        uint256 nextId = registry.registerListing(
            creator, keccak256("second"), 120_000, "https://promit.example/2"
        );
        assertEq(nextId, listingId + 1, "listing counter must continue across the upgrade");
    }
}
