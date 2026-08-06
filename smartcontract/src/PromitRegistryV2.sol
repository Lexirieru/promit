// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PromitRegistry} from "./PromitRegistry.sol";

/// @title PromitRegistryV2
/// @notice Upgrade fixture: proves the proxy can move to a new implementation with every
///         listing and unlock record intact (AE6), and gives U9's upgrade script a real
///         target. Inherits V1 so the storage layout is identical by construction; new
///         state in later versions must only ever be appended after the inherited slots.
/// @custom:oz-upgrades-from PromitRegistry
contract PromitRegistryV2 is PromitRegistry {
    /// @notice Distinguishes the implementations: V1 has no version(), so a successful
    ///         call proves the proxy is executing the new code.
    function version() external pure returns (string memory) {
        return "2";
    }
}
