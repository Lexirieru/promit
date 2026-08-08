// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PromitRegistry} from "./PromitRegistry.sol";

/// @title PromitRegistryV3
/// @notice Adds creator escrow: the proxy holds the USDC buyers pay, the settler records
///         who is owed what, and each creator withdraws their own balance.
///
/// @dev Why the money moves this way. x402's `exact` scheme settles one EIP-3009
///      `transferWithAuthorization` to one recipient, so a payment cannot be split between
///      creator and protocol at settlement time. Something has to receive the gross and
///      forward a share. Doing that from a server means a key that can move all revenue
///      sits next to the web app; doing it here means creators pull, pay their own gas, and
///      no off-chain key can move anyone's funds.
///
///      This reverses KTD3, which forbade pointing `PAY_TO_ADDRESS` at the proxy. That rule
///      existed because the proxy had no way to account for or release funds — it would
///      have been a hole with no bottom. It now has both, so the reason is gone.
///
///      Storage is appended after every inherited slot and nothing is reordered, which is
///      what makes this a legal UUPS upgrade. `PromitRegistryUpgrade.t.sol` asserts the
///      OpenZeppelin validator agrees rather than trusting the claim.
/// @custom:oz-upgrades-from PromitRegistry
contract PromitRegistryV3 is PromitRegistry {
    using SafeERC20 for IERC20;

    /// @notice The token creators are paid in. Set once by the upgrade.
    IERC20 public payoutToken;

    /// @notice Owed to each creator, in the token's atomic units.
    mapping(address creator => uint256 amount) private _claimable;

    /// @notice Sum of every unclaimed balance. The invariant that makes credits honest.
    uint256 private _totalClaimable;

    event PayoutTokenSet(address indexed token);
    event CreatorCredited(address indexed creator, uint256 amount, uint256 totalClaimable);
    event CreatorClaimed(address indexed creator, uint256 amount);

    error PayoutTokenNotSet();
    error PayoutTokenAlreadySet();
    // ZeroAddress is inherited from PromitRegistry; redeclaring it would shadow.
    error ZeroAmount();
    /// @dev Raised when a credit would allocate money the contract does not hold.
    error CreditExceedsBalance(uint256 requested, uint256 unallocated);
    error NothingToClaim();

    /// @notice Names the payout token. Callable once, by the upgrade authority.
    /// @dev Deliberately NOT a `reinitializer`: this contract adds no inherited initializers
    ///      to run, and a version-gated initializer would be one more number to keep in step
    ///      across future upgrades. The one-shot check below is the whole requirement.
    function setPayoutToken(address token) external onlyRole(UPGRADER_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (address(payoutToken) != address(0)) revert PayoutTokenAlreadySet();
        payoutToken = IERC20(token);
        emit PayoutTokenSet(token);
    }

    /// @notice Records that a creator is owed `amount`.
    ///
    /// @dev The balance check is the security property, not a sanity check. A compromised
    ///      settler key can point a credit at the wrong creator, but it can never credit
    ///      more than has actually arrived — total credits are bounded by the contract's own
    ///      balance, so no attacker can mint a claim out of nothing or drain a balance that
    ///      belongs to someone else. That bound is why holding funds here is safer than
    ///      holding them in a hot wallet the settler could simply transfer from.
    function creditCreator(address creator, uint256 amount) external onlyRole(SETTLER_ROLE) {
        if (address(payoutToken) == address(0)) revert PayoutTokenNotSet();
        if (creator == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 unallocated = payoutToken.balanceOf(address(this)) - _totalClaimable;
        if (amount > unallocated) revert CreditExceedsBalance(amount, unallocated);

        _claimable[creator] += amount;
        _totalClaimable += amount;
        emit CreatorCredited(creator, amount, _totalClaimable);
    }

    /// @notice Withdraws everything owed to the caller.
    /// @dev No amount argument and no recipient argument: a creator can only ever move their
    ///      own full balance to their own address, which removes every way to point a claim
    ///      somewhere else. Balances are zeroed BEFORE the transfer so a token with a
    ///      callback cannot re-enter and claim twice.
    function claim() external returns (uint256 amount) {
        amount = _claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();

        _claimable[msg.sender] = 0;
        _totalClaimable -= amount;
        emit CreatorClaimed(msg.sender, amount);
        payoutToken.safeTransfer(msg.sender, amount);
    }

    /// @notice What `creator` can withdraw right now.
    function claimableOf(address creator) external view returns (uint256) {
        return _claimable[creator];
    }

    /// @notice Sum of every unclaimed balance.
    function totalClaimable() external view returns (uint256) {
        return _totalClaimable;
    }

    /// @notice Balance not yet promised to anyone — the protocol's accrued fees.
    /// @dev Exposed so the split is auditable from the chain alone: fees are whatever
    ///      arrived and was never credited, not a number anyone has to be told.
    function unallocatedBalance() external view returns (uint256) {
        if (address(payoutToken) == address(0)) return 0;
        return payoutToken.balanceOf(address(this)) - _totalClaimable;
    }

    function version() external pure returns (string memory) {
        return "3";
    }
}
