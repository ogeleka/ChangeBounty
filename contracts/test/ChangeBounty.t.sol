// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ChangeBounty} from "../ChangeBounty.sol";

/// @dev Simple 6-decimals mock USDC with open mint.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns 1% of every wallet-to-wallet transfer, so recipients receive less than requested.
contract FeeOnTransferToken is MockUSDC {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, to, value - fee);
            if (fee != 0) super._update(from, address(0), fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Token that, once armed, calls back into `target` mid-transfer. It can also act as an
/// account (via `forward`) so the reentrant call is made by an authorized role (verifier/creator),
/// meaning only the reentrancy guard can stop it.
contract ReentrantToken is MockUSDC {
    address public target;
    bytes public data;
    bool public onIncoming; // trigger when tokens flow INTO target (else OUT of target)
    bool public armed;
    bool public reentered;
    bool public reentrySucceeded;
    bytes public reentryRevert;

    function arm(address target_, bytes calldata data_, bool incoming) external {
        target = target_;
        data = data_;
        onIncoming = incoming;
        armed = true;
    }

    function approveSpender(address spender) external {
        _approve(address(this), spender, type(uint256).max);
    }

    function forward(address t, bytes calldata d) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = t.call(d);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && ((onIncoming && to == target) || (!onIncoming && from == target))) {
            armed = false;
            reentered = true;
            (bool ok, bytes memory ret) = target.call(data);
            reentrySucceeded = ok;
            reentryRevert = ret;
        }
    }
}

/// @dev Bounded action surface for invariant testing; tracks ghost accounting.
contract BountyHandler is Test {
    ChangeBounty public bounty;
    MockUSDC public usdc;
    address public verifier;
    address public agent;
    address[] public creators;

    uint256 public ghostFunded;
    uint256 public ghostPaid;
    uint256 public ghostWithdrawn;
    address public outsider = makeAddr("handlerOutsider");
    uint256 public ghostOutsiderMinted;

    constructor(ChangeBounty b, MockUSDC u, address verifier_) {
        bounty = b;
        usdc = u;
        verifier = verifier_;
        agent = makeAddr("handlerAgent");
        for (uint256 i = 0; i < 3; i++) {
            address c = makeAddr(string.concat("handlerCreator", vm.toString(i)));
            creators.push(c);
            vm.prank(c);
            u.approve(address(b), type(uint256).max);
        }
    }

    function _pick(uint256 seed) internal view returns (uint256 id) {
        uint256 count = bounty.jobCount();
        if (count == 0) return 0;
        id = bound(seed, 1, count);
    }

    function createJob(uint256 who, uint256 reward, uint256 funding) external {
        address c = creators[who % creators.length];
        reward = bound(reward, 1, 1e9);
        funding = bound(funding, 0, 1e10);
        usdc.mint(c, funding);
        vm.prank(c);
        bounty.createJob("https://example.com/page", agent, uint128(reward), uint128(funding));
        ghostFunded += funding;
    }

    function fundJob(uint256 jobSeed, uint256, uint256 amount) external {
        uint256 id = _pick(jobSeed);
        if (id == 0) return;
        if (bounty.getJob(id).status != ChangeBounty.Status.Active) return;
        address f = bounty.getJob(id).creator; // only the creator may fund
        amount = bound(amount, 0, 1e10);
        usdc.mint(f, amount);
        vm.prank(f);
        bounty.fundJob(id, uint128(amount));
        ghostFunded += amount;
    }

    /// Any non-creator funding attempt must revert and leave all balances untouched.
    function thirdPartyFundJob(uint256 jobSeed, uint256 amount) external {
        uint256 id = _pick(jobSeed);
        if (id == 0) return;
        amount = bound(amount, 0, 1e10);
        usdc.mint(outsider, amount);
        ghostOutsiderMinted += amount;
        vm.startPrank(outsider);
        usdc.approve(address(bounty), type(uint256).max);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.fundJob(id, uint128(amount));
        vm.stopPrank();
    }

    function payDiscovery(uint256 jobSeed, uint256 idSeed) external {
        uint256 id = _pick(jobSeed);
        if (id == 0) return;
        ChangeBounty.Job memory j = bounty.getJob(id);
        if (j.status != ChangeBounty.Status.Active || j.balance < j.reward) return;
        bytes32 did = bytes32(bound(idSeed, 1, 6)); // small space -> duplicates are exercised
        if (bounty.paid(id, did)) return;
        vm.prank(verifier);
        bounty.payDiscovery(id, did);
        ghostPaid += j.reward;
    }

    function cancelJob(uint256 jobSeed) external {
        uint256 id = _pick(jobSeed);
        if (id == 0) return;
        ChangeBounty.Job memory j = bounty.getJob(id);
        if (j.status != ChangeBounty.Status.Active) return;
        vm.prank(j.creator);
        bounty.cancelJob(id);
    }

    function withdrawUnused(uint256 jobSeed) external {
        uint256 id = _pick(jobSeed);
        if (id == 0) return;
        ChangeBounty.Job memory j = bounty.getJob(id);
        if (j.status != ChangeBounty.Status.Cancelled || j.balance == 0) return;
        vm.prank(j.creator);
        bounty.withdrawUnused(id);
        ghostWithdrawn += j.balance;
    }

    function cancelAndWithdraw(uint256 jobSeed) external {
        uint256 id = _pick(jobSeed);
        if (id == 0) return;
        ChangeBounty.Job memory j = bounty.getJob(id);
        if (j.status != ChangeBounty.Status.Active || j.balance == 0) return;
        vm.prank(j.creator);
        bounty.cancelAndWithdraw(id);
        ghostWithdrawn += j.balance;
    }

    function sumJobBalances() external view returns (uint256 sum) {
        uint256 count = bounty.jobCount();
        for (uint256 i = 1; i <= count; i++) {
            sum += bounty.getJob(i).balance;
        }
    }
}

contract ChangeBountyTest is Test {
    ChangeBounty internal bounty;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal verifier = makeAddr("verifier");
    address internal creator = makeAddr("creator");
    address internal agent = makeAddr("agent");
    address internal other = makeAddr("other");

    uint128 internal constant REWARD = 100e6;
    uint128 internal constant FUND = 1_000e6;
    string internal constant URL = "https://example.com/changelog";
    bytes32 internal constant D1 = keccak256("discovery-1");
    bytes32 internal constant D2 = keccak256("discovery-2");

    function setUp() public {
        usdc = new MockUSDC();
        bounty = new ChangeBounty(address(usdc), verifier, owner);
        _fundActor(creator);
        _fundActor(other);
    }

    // ---------------------------------------------------------------- helpers

    function _fundActor(address who) internal {
        usdc.mint(who, 10_000_000e6);
        vm.prank(who);
        usdc.approve(address(bounty), type(uint256).max);
    }

    function _create(uint128 funding) internal returns (uint256 id) {
        vm.prank(creator);
        id = bounty.createJob(URL, agent, REWARD, funding);
    }

    function _pay(uint256 id, bytes32 did) internal {
        vm.prank(verifier);
        bounty.payDiscovery(id, did);
    }

    function _urlOfLength(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) b[i] = "a";
        return string(b);
    }

    // ------------------------------------------------------------ deployment

    function test_Constructor_SetsState() public view {
        assertEq(address(bounty.usdc()), address(usdc));
        assertEq(bounty.verifier(), verifier);
        assertEq(bounty.owner(), owner);
        assertEq(bounty.jobCount(), 0);
    }

    function test_Constructor_RevertsOnZeroUsdc() public {
        vm.expectRevert(ChangeBounty.ZeroAddress.selector);
        new ChangeBounty(address(0), verifier, owner);
    }

    function test_Constructor_RevertsOnZeroVerifier() public {
        vm.expectRevert(ChangeBounty.ZeroAddress.selector);
        new ChangeBounty(address(usdc), address(0), owner);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ChangeBounty(address(usdc), verifier, address(0));
    }

    // ------------------------------------------------------------- createJob

    function test_CreateJob_WithFunding_StoresJobAndPullsFunds() public {
        uint256 creatorBefore = usdc.balanceOf(creator);
        uint256 id = _create(FUND);

        assertEq(id, 1);
        assertEq(bounty.jobCount(), 1);
        ChangeBounty.Job memory j = bounty.getJob(id);
        assertEq(j.creator, creator);
        assertEq(j.agent, agent);
        assertEq(j.reward, REWARD);
        assertEq(j.balance, FUND);
        assertEq(j.createdAt, uint64(block.timestamp));
        assertEq(j.payouts, 0);
        assertEq(uint8(j.status), uint8(ChangeBounty.Status.Active));
        assertEq(j.urlHash, keccak256(bytes(URL)));
        assertEq(usdc.balanceOf(address(bounty)), FUND);
        assertEq(usdc.balanceOf(creator), creatorBefore - FUND);
    }

    function test_CreateJob_EmitsCreatedAndFunded() public {
        vm.expectEmit(true, true, true, true, address(bounty));
        emit ChangeBounty.JobCreated(1, creator, agent, REWARD, URL, keccak256(bytes(URL)));
        vm.expectEmit(true, true, false, true, address(bounty));
        emit ChangeBounty.JobFunded(1, creator, FUND, FUND);
        vm.prank(creator);
        bounty.createJob(URL, agent, REWARD, FUND);
    }

    function test_CreateJob_ZeroFundingAllowed_NoTransferNoFundedEvent() public {
        vm.recordLogs();
        uint256 id = _create(0);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only JobCreated");
        assertEq(logs[0].topics[0], ChangeBounty.JobCreated.selector);
        assertEq(bounty.getJob(id).balance, 0);
        assertEq(usdc.balanceOf(address(bounty)), 0);
    }

    function test_CreateJob_FundingBelowRewardAllowed() public {
        uint256 id = _create(REWARD - 1);
        assertEq(bounty.getJob(id).balance, REWARD - 1);
    }

    function test_CreateJob_IncrementsIdsAndSetsDistinctCreators() public {
        uint256 a = _create(0);
        vm.prank(other);
        uint256 b = bounty.createJob(URL, agent, REWARD, 0);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(bounty.getJob(b).creator, other);
    }

    function test_CreateJob_MaxUrlLength512Accepted() public {
        vm.prank(creator);
        uint256 id = bounty.createJob(_urlOfLength(512), agent, REWARD, 0);
        assertEq(id, 1);
    }

    function test_RevertCreateJob_EmptyUrl() public {
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.InvalidUrlLength.selector);
        bounty.createJob("", agent, REWARD, 0);
    }

    function test_RevertCreateJob_Url513() public {
        string memory u = _urlOfLength(513);
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.InvalidUrlLength.selector);
        bounty.createJob(u, agent, REWARD, 0);
    }

    function test_RevertCreateJob_ZeroAgent() public {
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.ZeroAddress.selector);
        bounty.createJob(URL, address(0), REWARD, 0);
    }

    function test_RevertCreateJob_ZeroReward() public {
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.InvalidReward.selector);
        bounty.createJob(URL, agent, 0, FUND);
    }

    function test_RevertCreateJob_InsufficientTokenBalance_NoJobCreated() public {
        address poor = makeAddr("poor");
        vm.startPrank(poor);
        usdc.approve(address(bounty), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, poor, 0, FUND)
        );
        bounty.createJob(URL, agent, REWARD, FUND);
        vm.stopPrank();
        assertEq(bounty.jobCount(), 0);
    }

    function test_RevertCreateJob_InsufficientAllowance() public {
        address noApprove = makeAddr("noApprove");
        usdc.mint(noApprove, FUND);
        vm.prank(noApprove);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(bounty), 0, FUND)
        );
        bounty.createJob(URL, agent, REWARD, FUND);
    }

    // --------------------------------------------------------------- fundJob

    function test_FundJob_TopUpIncreasesBalanceAndEmits() public {
        uint256 id = _create(FUND);
        vm.expectEmit(true, true, false, true, address(bounty));
        emit ChangeBounty.JobFunded(id, creator, 500e6, FUND + 500e6);
        vm.prank(creator);
        bounty.fundJob(id, 500e6);

        assertEq(bounty.getJob(id).balance, FUND + 500e6);
        assertEq(usdc.balanceOf(address(bounty)), FUND + 500e6);
    }

    function test_RevertFundJob_ThirdPartyCannotFund_NoFundsCapturedOrMoved() public {
        uint256 id = _create(FUND);
        address[4] memory callers = [other, verifier, owner, agent];
        for (uint256 i = 0; i < callers.length; i++) {
            address c = callers[i];
            usdc.mint(c, 5 * uint256(FUND));
            vm.prank(c);
            usdc.approve(address(bounty), type(uint256).max);

            uint256 callerBefore = usdc.balanceOf(c);
            vm.prank(c);
            vm.expectRevert(ChangeBounty.NotJobCreator.selector);
            bounty.fundJob(id, FUND);

            // zero-amount third-party top-ups are rejected too
            vm.prank(c);
            vm.expectRevert(ChangeBounty.NotJobCreator.selector);
            bounty.fundJob(id, 0);

            assertEq(usdc.balanceOf(c), callerBefore, "third-party funds untouched");
        }
        assertEq(bounty.getJob(id).balance, FUND, "job balance unchanged");
        assertEq(usdc.balanceOf(address(bounty)), FUND, "escrow unchanged");
        assertEq(bounty.getJob(id).creator, creator);
    }

    function test_RevertFundJob_ThirdPartyRevertsEvenWhenJobEmpty_CreatorRefundUnaffected() public {
        uint256 id = _create(0);
        vm.prank(other);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.fundJob(id, FUND);
        assertEq(bounty.getJob(id).balance, 0);
        assertEq(usdc.balanceOf(address(bounty)), 0);

        // creator can still fund and recover exactly what they put in
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        bounty.fundJob(id, FUND);
        vm.prank(creator);
        bounty.cancelAndWithdraw(id);
        assertEq(usdc.balanceOf(creator), creatorBefore);
    }

    function test_RevertFundJob_ThirdPartyOnCancelledJob_NotJobCreatorTakesPrecedence() public {
        uint256 id = _create(FUND);
        vm.prank(creator);
        bounty.cancelJob(id);
        vm.prank(other);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.fundJob(id, 1);
        assertEq(usdc.balanceOf(address(bounty)), FUND);
    }

    function test_RevertFundJob_ThirdPartyUnknownJob_JobNotFound() public {
        vm.prank(other);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.fundJob(1, 1);
    }

    function test_FundJob_ZeroAmountAllowed() public {
        uint256 id = _create(FUND);
        vm.expectEmit(true, true, false, true, address(bounty));
        emit ChangeBounty.JobFunded(id, creator, 0, FUND);
        vm.prank(creator);
        bounty.fundJob(id, 0);
        assertEq(bounty.getJob(id).balance, FUND);
        assertEq(usdc.balanceOf(address(bounty)), FUND);
    }

    function test_RevertFundJob_UnknownJob() public {
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.fundJob(0, 1);
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.fundJob(1, 1);
    }

    function test_RevertFundJob_CancelledJob() public {
        uint256 id = _create(FUND);
        vm.prank(creator);
        bounty.cancelJob(id);
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.JobNotActive.selector);
        bounty.fundJob(id, 1);
    }

    function test_RevertFundJob_Uint128BalanceOverflow() public {
        usdc.mint(creator, type(uint128).max);
        uint256 id = _create(type(uint128).max);
        vm.prank(creator);
        vm.expectRevert(); // arithmetic overflow panic
        bounty.fundJob(id, 1);
        assertEq(bounty.getJob(id).balance, type(uint128).max);
    }

    function test_RevertFundJob_InsufficientAllowance() public {
        uint256 id = _create(0);
        vm.startPrank(creator);
        usdc.approve(address(bounty), 0); // creator revokes allowance
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(bounty), 0, FUND)
        );
        bounty.fundJob(id, FUND);
        vm.stopPrank();
        assertEq(bounty.getJob(id).balance, 0);
    }

    // ----------------------------------------------------------- payDiscovery

    function test_PayDiscovery_PaysExactlyRewardToAgent() public {
        uint256 id = _create(FUND);
        uint256 agentBefore = usdc.balanceOf(agent);

        _pay(id, D1);

        assertEq(usdc.balanceOf(agent), agentBefore + REWARD);
        assertEq(usdc.balanceOf(address(bounty)), FUND - REWARD);
        ChangeBounty.Job memory j = bounty.getJob(id);
        assertEq(j.balance, FUND - REWARD);
        assertEq(j.payouts, 1);
        assertTrue(bounty.paid(id, D1));
        assertTrue(bounty.isPaid(id, D1));
        assertFalse(bounty.isPaid(id, D2));
    }

    function test_PayDiscovery_EmitsEvent() public {
        uint256 id = _create(FUND);
        vm.expectEmit(true, true, true, true, address(bounty));
        emit ChangeBounty.DiscoveryPaid(id, D1, agent, REWARD, verifier);
        _pay(id, D1);
    }

    function test_PayDiscovery_ExactBalanceEqualToRewardSucceeds() public {
        uint256 id = _create(REWARD);
        _pay(id, D1);
        assertEq(bounty.getJob(id).balance, 0);
        assertEq(usdc.balanceOf(agent), REWARD);
    }

    function test_PayDiscovery_MultipleDistinctIdsPayEachOnce() public {
        uint256 id = _create(FUND);
        _pay(id, D1);
        _pay(id, D2);
        assertEq(usdc.balanceOf(agent), 2 * uint256(REWARD));
        assertEq(bounty.getJob(id).payouts, 2);
    }

    function test_PayDiscovery_DiscoveryIdsScopedPerJob() public {
        uint256 a = _create(FUND);
        uint256 b = _create(FUND);
        _pay(a, D1);
        assertTrue(bounty.isPaid(a, D1));
        assertFalse(bounty.isPaid(b, D1));
        _pay(b, D1); // same id on a different job is fine
        assertEq(usdc.balanceOf(agent), 2 * uint256(REWARD));
        // but still a duplicate within each job
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.DiscoveryAlreadyPaid.selector);
        bounty.payDiscovery(b, D1);
    }

    function test_RevertPayDiscovery_NonVerifier() public {
        uint256 id = _create(FUND);
        address[4] memory callers = [owner, creator, agent, other];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(ChangeBounty.NotVerifier.selector);
            bounty.payDiscovery(id, D1);
        }
        assertEq(usdc.balanceOf(agent), 0);
    }

    function test_RevertPayDiscovery_Duplicate() public {
        uint256 id = _create(FUND);
        _pay(id, D1);
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.DiscoveryAlreadyPaid.selector);
        bounty.payDiscovery(id, D1);
        assertEq(usdc.balanceOf(agent), REWARD);
    }

    function test_RevertPayDiscovery_ZeroDiscoveryId() public {
        uint256 id = _create(FUND);
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.InvalidDiscoveryId.selector);
        bounty.payDiscovery(id, bytes32(0));
    }

    function test_RevertPayDiscovery_UnknownJob() public {
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.payDiscovery(0, D1);
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.payDiscovery(1, D1);
    }

    function test_RevertPayDiscovery_InsufficientBalance() public {
        uint256 id = _create(REWARD - 1);
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.InsufficientJobBalance.selector);
        bounty.payDiscovery(id, D1);
        assertFalse(bounty.isPaid(id, D1)); // failed attempt does not burn the id
    }

    function test_RevertPayDiscovery_BalanceExhausted_ThenTopUpAllowsSameId() public {
        uint256 id = _create(REWARD);
        _pay(id, D1);
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.InsufficientJobBalance.selector);
        bounty.payDiscovery(id, D2);

        vm.prank(creator);
        bounty.fundJob(id, REWARD);
        _pay(id, D2);
        assertEq(usdc.balanceOf(agent), 2 * uint256(REWARD));
    }

    function test_RevertPayDiscovery_CancelledJob() public {
        uint256 id = _create(FUND);
        vm.prank(creator);
        bounty.cancelJob(id);
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.JobNotActive.selector);
        bounty.payDiscovery(id, D1);
        assertEq(usdc.balanceOf(agent), 0);
    }

    // ------------------------------------------------------------ view funcs

    function test_RevertGetJob_Unknown() public {
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.getJob(0);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.getJob(1);
    }

    function test_RevertIsPaid_UnknownJob() public {
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.isPaid(1, D1);
    }

    // ------------------------------------------------------------- cancelJob

    function test_CancelJob_SetsCancelledEmitsAndMovesNoFunds() public {
        uint256 id = _create(FUND);
        vm.expectEmit(true, false, false, true, address(bounty));
        emit ChangeBounty.JobCancelled(id);
        vm.prank(creator);
        bounty.cancelJob(id);

        ChangeBounty.Job memory j = bounty.getJob(id);
        assertEq(uint8(j.status), uint8(ChangeBounty.Status.Cancelled));
        assertEq(j.balance, FUND);
        assertEq(usdc.balanceOf(address(bounty)), FUND);
    }

    function test_CancelJob_EmptyJobCanBeCancelled() public {
        uint256 id = _create(0);
        vm.prank(creator);
        bounty.cancelJob(id);
        assertEq(uint8(bounty.getJob(id).status), uint8(ChangeBounty.Status.Cancelled));
    }

    function test_RevertCancelJob_NonCreator() public {
        uint256 id = _create(FUND);
        vm.prank(other);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.cancelJob(id);
    }

    function test_RevertCancelJob_AlreadyCancelled() public {
        uint256 id = _create(FUND);
        vm.startPrank(creator);
        bounty.cancelJob(id);
        vm.expectRevert(ChangeBounty.JobNotActive.selector);
        bounty.cancelJob(id);
        vm.stopPrank();
    }

    function test_RevertCancelJob_UnknownJob() public {
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.cancelJob(7);
    }

    // --------------------------------------------------------- withdrawUnused

    function test_WithdrawUnused_AfterCancel_RefundsRemainingToCreator() public {
        uint256 id = _create(FUND);
        _pay(id, D1);
        vm.prank(creator);
        bounty.cancelJob(id);

        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.expectEmit(true, true, false, true, address(bounty));
        emit ChangeBounty.FundsWithdrawn(id, creator, FUND - REWARD);
        vm.prank(creator);
        bounty.withdrawUnused(id);

        assertEq(usdc.balanceOf(creator), creatorBefore + FUND - REWARD);
        assertEq(bounty.getJob(id).balance, 0);
        assertEq(usdc.balanceOf(address(bounty)), 0);
    }

    function test_RevertWithdrawUnused_BeforeCancel() public {
        uint256 id = _create(FUND);
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.JobNotCancelled.selector);
        bounty.withdrawUnused(id);
    }

    function test_RevertWithdrawUnused_NonCreator() public {
        uint256 id = _create(FUND);
        vm.prank(creator);
        bounty.cancelJob(id);
        vm.prank(other);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.withdrawUnused(id);
    }

    function test_RevertWithdrawUnused_NonCreatorBeforeCancel() public {
        uint256 id = _create(FUND);
        vm.prank(other);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.withdrawUnused(id);
    }

    function test_RevertWithdrawUnused_NothingToWithdraw_EmptyJob() public {
        uint256 id = _create(0);
        vm.startPrank(creator);
        bounty.cancelJob(id);
        vm.expectRevert(ChangeBounty.NothingToWithdraw.selector);
        bounty.withdrawUnused(id);
        vm.stopPrank();
    }

    function test_RevertWithdrawUnused_SecondWithdrawNothingLeft() public {
        uint256 id = _create(FUND);
        vm.startPrank(creator);
        bounty.cancelJob(id);
        bounty.withdrawUnused(id);
        vm.expectRevert(ChangeBounty.NothingToWithdraw.selector);
        bounty.withdrawUnused(id);
        vm.stopPrank();
    }

    function test_RevertWithdrawUnused_UnknownJob() public {
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.withdrawUnused(1);
    }

    // ------------------------------------------------------- cancelAndWithdraw

    function test_CancelAndWithdraw_RefundsAndCancelsAtomically() public {
        uint256 id = _create(FUND);
        uint256 creatorBefore = usdc.balanceOf(creator);

        vm.expectEmit(true, false, false, true, address(bounty));
        emit ChangeBounty.JobCancelled(id);
        vm.expectEmit(true, true, false, true, address(bounty));
        emit ChangeBounty.FundsWithdrawn(id, creator, FUND);
        vm.prank(creator);
        bounty.cancelAndWithdraw(id);

        ChangeBounty.Job memory j = bounty.getJob(id);
        assertEq(uint8(j.status), uint8(ChangeBounty.Status.Cancelled));
        assertEq(j.balance, 0);
        assertEq(usdc.balanceOf(creator), creatorBefore + FUND);
        assertEq(usdc.balanceOf(address(bounty)), 0);
    }

    function test_RevertCancelAndWithdraw_NonCreator() public {
        uint256 id = _create(FUND);
        vm.prank(other);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.cancelAndWithdraw(id);
    }

    function test_RevertCancelAndWithdraw_EmptyJob_RollsBackCancellation() public {
        uint256 id = _create(0);
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.NothingToWithdraw.selector);
        bounty.cancelAndWithdraw(id);
        assertEq(uint8(bounty.getJob(id).status), uint8(ChangeBounty.Status.Active));
    }

    function test_RevertCancelAndWithdraw_AlreadyCancelled() public {
        uint256 id = _create(FUND);
        vm.startPrank(creator);
        bounty.cancelJob(id);
        vm.expectRevert(ChangeBounty.JobNotActive.selector);
        bounty.cancelAndWithdraw(id);
        vm.stopPrank();
    }

    function test_RevertCancelAndWithdraw_UnknownJob() public {
        vm.prank(creator);
        vm.expectRevert(ChangeBounty.JobNotFound.selector);
        bounty.cancelAndWithdraw(99);
    }

    // ---------------------------------------------- owner has no access to funds

    function test_OwnerCannotTakeJobFunds() public {
        uint256 id = _create(FUND);
        vm.startPrank(owner);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.cancelJob(id);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.withdrawUnused(id);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.cancelAndWithdraw(id);
        vm.expectRevert(ChangeBounty.NotVerifier.selector);
        bounty.payDiscovery(id, D1);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(bounty)), FUND);
        assertEq(usdc.balanceOf(owner), 0);

        // also after cancellation
        vm.prank(creator);
        bounty.cancelJob(id);
        vm.prank(owner);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.withdrawUnused(id);
        assertEq(usdc.balanceOf(address(bounty)), FUND);
    }

    // ------------------------------------------------------------ setVerifier

    function test_SetVerifier_OwnerRotatesAndEmits() public {
        address newV = makeAddr("newVerifier");
        vm.expectEmit(true, true, false, true, address(bounty));
        emit ChangeBounty.VerifierUpdated(verifier, newV);
        vm.prank(owner);
        bounty.setVerifier(newV);
        assertEq(bounty.verifier(), newV);
    }

    function test_SetVerifier_OldVerifierLosesRightsNewGains() public {
        uint256 id = _create(FUND);
        address newV = makeAddr("newVerifier");
        vm.prank(owner);
        bounty.setVerifier(newV);

        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.NotVerifier.selector);
        bounty.payDiscovery(id, D1);

        vm.prank(newV);
        bounty.payDiscovery(id, D1);
        assertEq(usdc.balanceOf(agent), REWARD);
    }

    function test_RevertSetVerifier_NonOwner() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        bounty.setVerifier(other);
        // the verifier itself has no owner rights either
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, verifier));
        bounty.setVerifier(other);
    }

    function test_RevertSetVerifier_Zero() public {
        vm.prank(owner);
        vm.expectRevert(ChangeBounty.ZeroAddress.selector);
        bounty.setVerifier(address(0));
        assertEq(bounty.verifier(), verifier);
    }

    // ----------------------------------------------------------- Ownable2Step

    function test_Ownable2Step_TransferThenAccept() public {
        address newOwner = makeAddr("newOwner");

        vm.expectEmit(true, true, false, false, address(bounty));
        emit Ownable2Step.OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        bounty.transferOwnership(newOwner);
        assertEq(bounty.owner(), owner, "owner unchanged until accepted");
        assertEq(bounty.pendingOwner(), newOwner);

        vm.expectEmit(true, true, false, false, address(bounty));
        emit Ownable.OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        bounty.acceptOwnership();
        assertEq(bounty.owner(), newOwner);
        assertEq(bounty.pendingOwner(), address(0));

        // old owner lost authority, new owner has it
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        bounty.setVerifier(other);
        vm.prank(newOwner);
        bounty.setVerifier(other);
        assertEq(bounty.verifier(), other);
    }

    function test_RevertOwnable2Step_AcceptByNonPending() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        bounty.transferOwnership(newOwner);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        bounty.acceptOwnership();
        assertEq(bounty.owner(), owner);
    }

    function test_RevertOwnable2Step_TransferByNonOwner() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        bounty.transferOwnership(other);
    }

    function test_RenounceOwnership_OwnerAlwaysReverts() public {
        vm.prank(owner);
        vm.expectRevert(ChangeBounty.RenounceDisabled.selector);
        bounty.renounceOwnership();
        assertEq(bounty.owner(), owner);
        // owner retains authority
        address newV = makeAddr("newVerifier");
        vm.prank(owner);
        bounty.setVerifier(newV);
        assertEq(bounty.verifier(), newV);
    }

    function test_RenounceOwnership_NonOwnerReverts_RenounceDisabled() public {
        address[4] memory callers = [other, verifier, creator, agent];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(ChangeBounty.RenounceDisabled.selector);
            bounty.renounceOwnership();
        }
        assertEq(bounty.owner(), owner);
    }

    function test_RenounceOwnership_RevertsWithPendingTransfer_AndKeepsPending() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        bounty.transferOwnership(newOwner);
        vm.prank(owner);
        vm.expectRevert(ChangeBounty.RenounceDisabled.selector);
        bounty.renounceOwnership();
        assertEq(bounty.owner(), owner);
        assertEq(bounty.pendingOwner(), newOwner);
        vm.prank(newOwner);
        bounty.acceptOwnership();
        assertEq(bounty.owner(), newOwner);
    }

    function test_RenounceOwnership_NewOwnerAlsoCannotRenounce() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        bounty.transferOwnership(newOwner);
        vm.prank(newOwner);
        bounty.acceptOwnership();
        vm.prank(newOwner);
        vm.expectRevert(ChangeBounty.RenounceDisabled.selector);
        bounty.renounceOwnership();
        assertEq(bounty.owner(), newOwner);
    }

    function testFuzz_RenounceOwnership_AlwaysReverts(address caller) public {
        vm.prank(caller);
        vm.expectRevert(ChangeBounty.RenounceDisabled.selector);
        bounty.renounceOwnership();
        assertEq(bounty.owner(), owner);
    }

    function test_Ownable2Step_TransferToZeroCancelsPending() public {
        address newOwner = makeAddr("newOwner");
        vm.startPrank(owner);
        bounty.transferOwnership(newOwner);
        bounty.transferOwnership(address(0));
        vm.stopPrank();
        assertEq(bounty.pendingOwner(), address(0));
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        bounty.acceptOwnership();
        assertEq(bounty.owner(), owner);
    }

    // ------------------------------------------- fee-on-transfer funding guard

    function _feeSetup() internal returns (FeeOnTransferToken fee, ChangeBounty b) {
        fee = new FeeOnTransferToken();
        b = new ChangeBounty(address(fee), verifier, owner);
        fee.mint(creator, 10_000_000e6);
        vm.prank(creator);
        fee.approve(address(b), type(uint256).max);
    }

    function test_RevertCreateJob_FeeOnTransferToken_UnexpectedFundingReceived() public {
        (FeeOnTransferToken fee, ChangeBounty b) = _feeSetup();
        uint256 received = FUND - FUND / 100;
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ChangeBounty.UnexpectedFundingReceived.selector, uint256(FUND), 0, received)
        );
        b.createJob(URL, agent, REWARD, FUND);
        assertEq(b.jobCount(), 0, "job creation rolled back");
        assertEq(fee.balanceOf(address(b)), 0);
    }

    function test_RevertFundJob_FeeOnTransferToken_UnexpectedFundingReceived() public {
        (, ChangeBounty b) = _feeSetup();
        vm.prank(creator);
        uint256 id = b.createJob(URL, agent, REWARD, 0); // zero funding skips the pull
        uint256 received = FUND - FUND / 100;
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ChangeBounty.UnexpectedFundingReceived.selector, uint256(FUND), 0, received)
        );
        b.fundJob(id, FUND);
        assertEq(b.getJob(id).balance, 0, "recorded balance rolled back");
    }

    function test_FeeOnTransferToken_TinyAmountWithoutFeeIsAccepted() public {
        // value/100 == 0 for amounts < 100, so no fee is taken: exact receipt passes the guard
        (, ChangeBounty b) = _feeSetup();
        vm.prank(creator);
        uint256 id = b.createJob(URL, agent, REWARD, 99);
        assertEq(b.getJob(id).balance, 99);
    }

    // ------------------------------------------------------------ reentrancy

    function _reentrantSetup() internal returns (ReentrantToken rt, ChangeBounty b) {
        rt = new ReentrantToken();
        b = new ChangeBounty(address(rt), address(rt), owner); // token is verifier AND can act as creator
        rt.mint(address(rt), 10 * uint256(FUND));
        rt.approveSpender(address(b));
    }

    function _assertGuardBlocked(ReentrantToken rt) internal view {
        assertTrue(rt.reentered(), "hook did not fire");
        assertFalse(rt.reentrySucceeded(), "reentry succeeded");
        assertEq(bytes4(rt.reentryRevert()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function test_Reentrancy_PayDiscoveryBlocked() public {
        (ReentrantToken rt, ChangeBounty b) = _reentrantSetup();
        rt.forward(address(b), abi.encodeCall(b.createJob, (URL, agent, REWARD, FUND)));
        // while paying D1 out, the (authorized) verifier tries to pay D2 in the same tx
        rt.arm(address(b), abi.encodeCall(b.payDiscovery, (1, D2)), false);
        rt.forward(address(b), abi.encodeCall(b.payDiscovery, (1, D1)));

        _assertGuardBlocked(rt);
        assertEq(rt.balanceOf(agent), REWARD, "exactly one reward");
        assertEq(rt.balanceOf(address(b)), FUND - REWARD);
        assertEq(b.getJob(1).balance, FUND - REWARD);
        assertFalse(b.paid(1, D2));
    }

    function test_Reentrancy_WithdrawUnusedBlocked() public {
        (ReentrantToken rt, ChangeBounty b) = _reentrantSetup();
        rt.forward(address(b), abi.encodeCall(b.createJob, (URL, agent, REWARD, FUND))); // creator == rt
        rt.forward(address(b), abi.encodeCall(b.cancelJob, (1)));
        uint256 before = rt.balanceOf(address(rt));
        // while refunding, the creator tries to withdraw again
        rt.arm(address(b), abi.encodeCall(b.withdrawUnused, (1)), false);
        rt.forward(address(b), abi.encodeCall(b.withdrawUnused, (1)));

        _assertGuardBlocked(rt);
        assertEq(rt.balanceOf(address(rt)), before + FUND, "refunded exactly once");
        assertEq(rt.balanceOf(address(b)), 0);
        assertEq(b.getJob(1).balance, 0);
    }

    function test_Reentrancy_CancelAndWithdrawBlockedFromWithdrawUnused() public {
        (ReentrantToken rt, ChangeBounty b) = _reentrantSetup();
        rt.forward(address(b), abi.encodeCall(b.createJob, (URL, agent, REWARD, FUND)));
        rt.arm(address(b), abi.encodeCall(b.withdrawUnused, (1)), false);
        rt.forward(address(b), abi.encodeCall(b.cancelAndWithdraw, (1)));
        _assertGuardBlocked(rt);
        assertEq(rt.balanceOf(address(b)), 0);
    }

    function test_Reentrancy_PayDiscoveryDuringFundJobPullBlocked() public {
        (ReentrantToken rt, ChangeBounty b) = _reentrantSetup();
        rt.forward(address(b), abi.encodeCall(b.createJob, (URL, agent, REWARD, FUND)));
        // tokens flowing INTO the bounty during fundJob trigger a payDiscovery attempt
        rt.arm(address(b), abi.encodeCall(b.payDiscovery, (1, D1)), true);
        rt.forward(address(b), abi.encodeCall(b.fundJob, (1, FUND)));

        _assertGuardBlocked(rt);
        assertEq(b.getJob(1).balance, 2 * uint256(FUND));
        assertEq(rt.balanceOf(agent), 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_ConservationOfFunds(
        uint256 rewardSeed,
        uint256 fundingSeed,
        uint256 topUpSeed,
        uint256 attemptsSeed
    ) public {
        uint128 reward = uint128(bound(rewardSeed, 1, 1e12));
        uint128 funding = uint128(bound(fundingSeed, 0, 1e15));
        uint128 topUp = uint128(bound(topUpSeed, 0, 1e15));
        uint256 attempts = bound(attemptsSeed, 0, 30);
        usdc.mint(creator, 1e16);
        usdc.mint(other, 1e16);
        uint256 creatorStart = usdc.balanceOf(creator);

        vm.prank(creator);
        uint256 id = bounty.createJob(URL, agent, reward, funding);
        // third-party funding is rejected and moves nothing
        uint256 otherStart = usdc.balanceOf(other);
        vm.prank(other);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.fundJob(id, topUp);
        assertEq(usdc.balanceOf(other), otherStart);
        assertEq(bounty.getJob(id).balance, funding);
        // creator top-up succeeds
        vm.prank(creator);
        bounty.fundJob(id, topUp);
        uint256 totalFunded = uint256(funding) + topUp;

        uint256 totalPaid;
        for (uint256 i = 1; i <= attempts; i++) {
            if (bounty.getJob(id).balance >= reward) {
                _pay(id, bytes32(i));
                totalPaid += reward;
            } else {
                vm.prank(verifier);
                vm.expectRevert(ChangeBounty.InsufficientJobBalance.selector);
                bounty.payDiscovery(id, bytes32(i));
            }
        }

        uint256 remaining = bounty.getJob(id).balance;
        assertEq(totalPaid + remaining, totalFunded, "paid + remaining == funded");
        assertEq(usdc.balanceOf(address(bounty)), remaining);
        assertEq(usdc.balanceOf(agent), totalPaid);

        uint256 withdrawn;
        vm.startPrank(creator);
        if (remaining > 0) {
            bounty.cancelAndWithdraw(id);
            withdrawn = remaining;
        } else {
            bounty.cancelJob(id);
        }
        vm.stopPrank();

        assertEq(totalPaid + withdrawn, totalFunded, "paid + withdrawn == funded");
        assertEq(bounty.getJob(id).balance, 0);
        assertEq(usdc.balanceOf(address(bounty)), 0);
        // the creator is the only one funding and refunded
        assertEq(usdc.balanceOf(creator), creatorStart - totalFunded + withdrawn);
        assertEq(usdc.balanceOf(other), otherStart);
    }

    function testFuzz_NonCreatorCannotFund(address caller, uint128 amount) public {
        vm.assume(caller != creator && caller != address(0));
        vm.assume(caller != address(bounty) && caller != address(usdc));
        uint256 id = _create(FUND);
        usdc.mint(caller, amount);
        vm.prank(caller);
        usdc.approve(address(bounty), type(uint256).max);
        uint256 callerBefore = usdc.balanceOf(caller);

        vm.prank(caller);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.fundJob(id, amount);

        assertEq(usdc.balanceOf(caller), callerBefore);
        assertEq(bounty.getJob(id).balance, FUND);
        assertEq(usdc.balanceOf(address(bounty)), FUND);
    }

    function testFuzz_PayDiscovery_PaysExactlyRewardToConfiguredAgent(
        address agent_,
        uint256 rewardSeed,
        uint256 fundingSeed,
        bytes32 did
    ) public {
        vm.assume(agent_ != address(0) && agent_ != address(bounty));
        vm.assume(did != bytes32(0));
        uint128 reward = uint128(bound(rewardSeed, 1, 1e12));
        uint128 funding = uint128(bound(fundingSeed, reward, 1e15));
        usdc.mint(creator, 1e16);

        vm.prank(creator);
        uint256 id = bounty.createJob(URL, agent_, reward, funding);
        uint256 before = usdc.balanceOf(agent_);
        _pay(id, did);

        assertEq(usdc.balanceOf(agent_), before + reward);
        assertEq(bounty.getJob(id).balance, funding - reward);
        assertTrue(bounty.isPaid(id, did));
    }

    function testFuzz_DiscoveryIdsScopedPerJob(bytes32 did) public {
        vm.assume(did != bytes32(0));
        uint256 a = _create(FUND);
        uint256 b = _create(FUND);
        _pay(a, did);
        assertFalse(bounty.isPaid(b, did));
        _pay(b, did);
        vm.prank(verifier);
        vm.expectRevert(ChangeBounty.DiscoveryAlreadyPaid.selector);
        bounty.payDiscovery(a, did);
    }

    function testFuzz_NonVerifierCannotPay(address caller, bytes32 did) public {
        vm.assume(caller != verifier);
        uint256 id = _create(FUND);
        vm.prank(caller);
        vm.expectRevert(ChangeBounty.NotVerifier.selector);
        bounty.payDiscovery(id, did);
    }

    function testFuzz_OnlyCreatorCanCancelOrWithdraw(address caller) public {
        vm.assume(caller != creator);
        uint256 id = _create(FUND);
        vm.startPrank(caller);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.cancelJob(id);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.withdrawUnused(id);
        vm.expectRevert(ChangeBounty.NotJobCreator.selector);
        bounty.cancelAndWithdraw(id);
        vm.stopPrank();
    }
}

contract ChangeBountyInvariantTest is Test {
    ChangeBounty internal bounty;
    MockUSDC internal usdc;
    BountyHandler internal handler;

    function setUp() public {
        usdc = new MockUSDC();
        address verifier = makeAddr("verifier");
        bounty = new ChangeBounty(address(usdc), verifier, makeAddr("owner"));
        handler = new BountyHandler(bounty, usdc, verifier);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[6] = BountyHandler.thirdPartyFundJob.selector;
        selectors[0] = BountyHandler.createJob.selector;
        selectors[1] = BountyHandler.fundJob.selector;
        selectors[2] = BountyHandler.payDiscovery.selector;
        selectors[3] = BountyHandler.cancelJob.selector;
        selectors[4] = BountyHandler.withdrawUnused.selector;
        selectors[5] = BountyHandler.cancelAndWithdraw.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Contract token balance always covers the sum of recorded job balances.
    function invariant_TokenBalanceCoversJobBalances() public view {
        assertGe(usdc.balanceOf(address(bounty)), handler.sumJobBalances());
    }

    /// Everything funded is either paid out, withdrawn, or still held in a job.
    function invariant_FundedEqualsPaidPlusWithdrawnPlusRemaining() public view {
        assertEq(handler.ghostFunded(), handler.ghostPaid() + handler.ghostWithdrawn() + handler.sumJobBalances());
    }

    /// Third-party funding attempts never capture or move the outsider's tokens.
    function invariant_ThirdPartyFundingNeverMovesFunds() public view {
        assertEq(usdc.balanceOf(handler.outsider()), handler.ghostOutsiderMinted());
    }

    /// The configured agent has received exactly the rewards paid, nothing more.
    function invariant_AgentReceivedExactlyPaidRewards() public view {
        assertEq(usdc.balanceOf(handler.agent()), handler.ghostPaid());
    }
}
