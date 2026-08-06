// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Options} from "openzeppelin-foundry-upgrades/Options.sol";
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
    string internal constant BAD = "PromitRegistryBadLayout.sol:PromitRegistryBadLayout";

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
}
