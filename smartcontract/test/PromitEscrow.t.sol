// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {PromitRegistry} from "../src/PromitRegistry.sol";
import {PromitRegistryV3} from "../src/PromitRegistryV3.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Creator escrow. The property under test throughout is that the settler can
///         DIRECT money but never CREATE it: total credits are bounded by what the contract
///         actually holds, which is what makes escrow safer than a hot wallet.
contract PromitEscrowTest is Test {
    PromitRegistryV3 internal registry;
    MockUSDC internal usdc;

    address internal upgradeAdmin = makeAddr("upgradeAdmin");
    address internal settler = makeAddr("settler");
    address internal creator = makeAddr("creator");
    address internal otherCreator = makeAddr("otherCreator");

    function setUp() public {
        usdc = new MockUSDC();
        PromitRegistryV3 implementation = new PromitRegistryV3();
        bytes memory data = abi.encodeCall(PromitRegistry.initialize, (upgradeAdmin, settler));
        registry = PromitRegistryV3(address(new ERC1967Proxy(address(implementation), data)));

        vm.prank(upgradeAdmin);
        registry.setPayoutToken(address(usdc));
    }

    /// @dev Buyers pay the proxy directly; x402 settles a plain transfer to `payTo`.
    function _buyerPays(uint256 amount) internal {
        usdc.mint(address(registry), amount);
    }

    // -----------------------------------------------------------------------
    // Crediting

    function test_creditThenClaimPaysTheCreator() public {
        _buyerPays(100_000);

        vm.prank(settler);
        registry.creditCreator(creator, 97_500);

        assertEq(registry.claimableOf(creator), 97_500);

        vm.prank(creator);
        uint256 claimed = registry.claim();

        assertEq(claimed, 97_500);
        assertEq(usdc.balanceOf(creator), 97_500);
        assertEq(registry.claimableOf(creator), 0);
        // The uncredited remainder is the protocol fee, readable from the chain alone.
        assertEq(registry.unallocatedBalance(), 2_500);
    }

    function test_creditCannotExceedWhatArrived() public {
        _buyerPays(100_000);

        vm.prank(settler);
        vm.expectRevert(
            abi.encodeWithSelector(PromitRegistryV3.CreditExceedsBalance.selector, 100_001, 100_000)
        );
        registry.creditCreator(creator, 100_001);
    }

    function test_creditsCannotOverdrawAcrossTwoCreators() public {
        // The bound is on the TOTAL, not on each credit: two credits that each look
        // affordable must not add up to more than the contract holds, or one creator's
        // claim would be paid out of another's money.
        _buyerPays(100_000);

        vm.startPrank(settler);
        registry.creditCreator(creator, 60_000);
        vm.expectRevert(
            abi.encodeWithSelector(PromitRegistryV3.CreditExceedsBalance.selector, 60_000, 40_000)
        );
        registry.creditCreator(otherCreator, 60_000);
        vm.stopPrank();
    }

    function test_creditsAccumulateAcrossSales() public {
        _buyerPays(100_000);
        vm.prank(settler);
        registry.creditCreator(creator, 97_500);

        _buyerPays(100_000);
        vm.prank(settler);
        registry.creditCreator(creator, 97_500);

        assertEq(registry.claimableOf(creator), 195_000);
        assertEq(registry.totalClaimable(), 195_000);
    }

    function test_onlySettlerCanCredit() public {
        _buyerPays(100_000);

        // Read the role BEFORE pranking: a call inside the expectRevert argument
        // would consume the prank and the revert would name this test contract.
        bytes32 settlerRole = registry.SETTLER_ROLE();
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, creator, settlerRole
            )
        );
        registry.creditCreator(creator, 1);
    }

    // -----------------------------------------------------------------------
    // Claiming

    function test_claimingTwiceGetsNothingTheSecondTime() public {
        _buyerPays(100_000);
        vm.prank(settler);
        registry.creditCreator(creator, 97_500);

        vm.prank(creator);
        registry.claim();

        vm.prank(creator);
        vm.expectRevert(PromitRegistryV3.NothingToClaim.selector);
        registry.claim();
        assertEq(usdc.balanceOf(creator), 97_500);
    }

    function test_oneCreatorCannotClaimAnothersBalance() public {
        _buyerPays(100_000);
        vm.prank(settler);
        registry.creditCreator(creator, 97_500);

        vm.prank(otherCreator);
        vm.expectRevert(PromitRegistryV3.NothingToClaim.selector);
        registry.claim();
    }

    function test_claimLeavesOtherCreatorsUntouched() public {
        _buyerPays(200_000);
        vm.startPrank(settler);
        registry.creditCreator(creator, 90_000);
        registry.creditCreator(otherCreator, 90_000);
        vm.stopPrank();

        vm.prank(creator);
        registry.claim();

        assertEq(registry.claimableOf(otherCreator), 90_000);
        assertEq(registry.totalClaimable(), 90_000);
        assertEq(usdc.balanceOf(address(registry)), 110_000);
    }

    /// @dev A claim frees its own allocation, so the next credit may use it again. Without
    ///      decrementing the total, escrow would slowly refuse credits for money it holds.
    function test_claimingReleasesTheAllocationForFutureCredits() public {
        _buyerPays(100_000);
        vm.prank(settler);
        registry.creditCreator(creator, 100_000);

        vm.prank(creator);
        registry.claim();

        _buyerPays(50_000);
        vm.prank(settler);
        registry.creditCreator(otherCreator, 50_000);

        assertEq(registry.claimableOf(otherCreator), 50_000);
    }

    // -----------------------------------------------------------------------
    // Configuration

    function test_payoutTokenIsSetOnce() public {
        vm.prank(upgradeAdmin);
        vm.expectRevert(PromitRegistryV3.PayoutTokenAlreadySet.selector);
        registry.setPayoutToken(address(usdc));
    }

    function test_onlyUpgradeAuthoritySetsThePayoutToken() public {
        PromitRegistryV3 fresh = PromitRegistryV3(
            address(
                new ERC1967Proxy(
                    address(new PromitRegistryV3()),
                    abi.encodeCall(PromitRegistry.initialize, (upgradeAdmin, settler))
                )
            )
        );

        // The settler runs on a server. Letting it name the token would let a compromised
        // backend point escrow at a token it controls and mint claims freely.
        bytes32 upgraderRole = fresh.UPGRADER_ROLE();
        vm.prank(settler);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, settler, upgraderRole
            )
        );
        fresh.setPayoutToken(address(usdc));
    }

    function test_creditFailsBeforeTheTokenIsNamed() public {
        PromitRegistryV3 fresh = PromitRegistryV3(
            address(
                new ERC1967Proxy(
                    address(new PromitRegistryV3()),
                    abi.encodeCall(PromitRegistry.initialize, (upgradeAdmin, settler))
                )
            )
        );

        vm.prank(settler);
        vm.expectRevert(PromitRegistryV3.PayoutTokenNotSet.selector);
        fresh.creditCreator(creator, 1);
    }

    // -----------------------------------------------------------------------
    // The registry it inherits still works

    function test_escrowDoesNotDisturbTheRegistryRecords() public {
        vm.startPrank(settler);
        uint256 listingId =
            registry.registerListing(creator, bytes32(uint256(1)), 100_000, "ipfs://x");
        registry.recordUnlock(otherCreator, bytes32(uint256(7)), listingId, 100_000);
        vm.stopPrank();

        assertTrue(registry.isUnlocked(otherCreator, bytes32(uint256(7))));
        assertEq(registry.getListing(listingId).creator, creator);
        assertEq(registry.version(), "3");
    }
}
