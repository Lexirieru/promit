// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/// @notice Deliberately broken upgrade candidate for PromitRegistry: the top-level storage
///         variables are reordered and the Listing struct members are shuffled. Everything
///         else (roles, constructor annotation, UUPS wiring) is kept valid so the only reason
///         the upgrade-safety validator can reject it is the storage layout. Lives under
///         test/ so it can never enter the deployable source set.
contract PromitRegistryBadLayout is Initializable, UUPSUpgradeable, AccessControlUpgradeable {
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    struct Listing {
        bytes32 contentHash;
        address creator;
        bool active;
        uint256 price;
        string metadataURI;
    }

    struct Unlock {
        address payer;
        bytes32 nonce;
        uint256 listingId;
        uint256 amount;
        uint64 recordedAt;
    }

    // V1 order is: _listingCount, _listings, _unlocks. This is the reorder a naive edit
    // produces, and it silently corrupts every already-written slot if it ever deploys.
    mapping(bytes32 unlockKey => Unlock) private _unlocks;
    mapping(uint256 listingId => Listing) private _listings;
    uint256 private _listingCount;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address upgradeAdmin, address settler) external initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, upgradeAdmin);
        _grantRole(UPGRADER_ROLE, upgradeAdmin);
        _grantRole(SETTLER_ROLE, settler);
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}
}
