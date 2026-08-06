// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/// @title PromitRegistry
/// @notice On-chain record of listed prompts and settled unlocks. The registry never custodies
///         funds: payments land in a plain wallet and the backend settler writes records here
///         after settlement, so a contract bug cannot take the payment path down.
/// @dev UUPS implementation deployed behind an ERC1967 proxy. The settler role is deliberately
///      separate from the upgrade authority: a compromised backend key can write records but
///      cannot swap the implementation.
contract PromitRegistry is Initializable, UUPSUpgradeable, AccessControlUpgradeable {
    /// @notice May record listings and unlocks. Held by the backend settler worker.
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    /// @notice May authorize upgrades. Held outside the backend and deploy environments.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    struct Listing {
        address creator;
        bytes32 contentHash;
        uint256 price;
        bool active;
        string metadataURI;
    }

    struct Unlock {
        address payer;
        bytes32 nonce;
        uint256 listingId;
        uint256 amount;
        uint64 recordedAt;
    }

    uint256 private _listingCount;
    mapping(uint256 listingId => Listing) private _listings;
    // Keyed on keccak256(abi.encode(payer, nonce)), never the raw nonce: EIP-3009 nonce
    // uniqueness is enforced per payer by the token contract, so the raw value is not
    // globally unique and two payers may legitimately reuse it.
    mapping(bytes32 unlockKey => Unlock) private _unlocks;

    event ListingRegistered(
        uint256 indexed listingId,
        address indexed creator,
        bytes32 contentHash,
        uint256 price,
        string metadataURI
    );
    event ListingActiveSet(uint256 indexed listingId, bool active);
    event UnlockRecorded(
        bytes32 indexed unlockKey,
        address indexed payer,
        bytes32 nonce,
        uint256 indexed listingId,
        uint256 amount
    );

    error ZeroAddress();
    error ZeroContentHash();
    error ZeroPrice();
    error UnknownListing(uint256 listingId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev No __UUPSUpgradeable_init here: in OpenZeppelin v5.7 the upgradeable package's
    ///      UUPSUpgradeable is a stateless re-export and has no initializer.
    function initialize(address upgradeAdmin, address settler) external initializer {
        if (upgradeAdmin == address(0) || settler == address(0)) revert ZeroAddress();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, upgradeAdmin);
        _grantRole(UPGRADER_ROLE, upgradeAdmin);
        _grantRole(SETTLER_ROLE, settler);
    }

    /// @notice Records a listing. The backend verifies the creator's signature (AE10) and
    ///         computes the content hash before writing, so writes are settler-gated and
    ///         `creator` is an explicit parameter rather than msg.sender.
    function registerListing(
        address creator,
        bytes32 contentHash,
        uint256 price,
        string calldata metadataURI
    ) external onlyRole(SETTLER_ROLE) returns (uint256 listingId) {
        if (creator == address(0)) revert ZeroAddress();
        if (contentHash == bytes32(0)) revert ZeroContentHash();
        if (price == 0) revert ZeroPrice();

        listingId = ++_listingCount;
        _listings[listingId] = Listing({
            creator: creator,
            contentHash: contentHash,
            price: price,
            active: true,
            metadataURI: metadataURI
        });
        emit ListingRegistered(listingId, creator, contentHash, price, metadataURI);
    }

    function setListingActive(uint256 listingId, bool active) external onlyRole(SETTLER_ROLE) {
        if (listingId == 0 || listingId > _listingCount) revert UnknownListing(listingId);
        _listings[listingId].active = active;
        emit ListingActiveSet(listingId, active);
    }

    /// @notice Records a settled unlock, idempotently. A repeat of the same (payer, nonce)
    ///         pair returns without reverting so a settler retry after a crash is harmless;
    ///         the settler is still expected to read the key first and skip the transaction.
    function recordUnlock(address payer, bytes32 nonce, uint256 listingId, uint256 amount)
        external
        onlyRole(SETTLER_ROLE)
    {
        if (payer == address(0)) revert ZeroAddress();
        if (listingId == 0 || listingId > _listingCount) revert UnknownListing(listingId);

        bytes32 key = keccak256(abi.encode(payer, nonce));
        if (_unlocks[key].payer != address(0)) return;

        _unlocks[key] = Unlock({
            payer: payer,
            nonce: nonce,
            listingId: listingId,
            amount: amount,
            recordedAt: uint64(block.timestamp)
        });
        emit UnlockRecorded(key, payer, nonce, listingId, amount);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        if (listingId == 0 || listingId > _listingCount) revert UnknownListing(listingId);
        return _listings[listingId];
    }

    function listingCount() external view returns (uint256) {
        return _listingCount;
    }

    function unlockKey(address payer, bytes32 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, nonce));
    }

    function getUnlock(address payer, bytes32 nonce) external view returns (Unlock memory) {
        return _unlocks[unlockKey(payer, nonce)];
    }

    function isUnlocked(address payer, bytes32 nonce) external view returns (bool) {
        return _unlocks[unlockKey(payer, nonce)].payer != address(0);
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}
}
