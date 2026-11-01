// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ChangeBounty
 * @notice USDC-funded website-change monitoring jobs with fixed agent rewards.
 * @dev Website verification relies on a trusted verifier service; URLs and discoveries
 * are not verified on-chain. A compromised verifier can at most pay out fixed rewards
 * from Active jobs to their configured agents, bounded by each job's funded balance.
 * It can fabricate distinct discovery IDs and exhaust those balances. Creators can
 * cancel and withdraw at any time, subject to transaction ordering and funds remaining.
 * The owner can propose a new verifier, which activates only after VERIFIER_DELAY (24 hours).
 * During that window the current verifier keeps working and creators can cancel and withdraw.
 * The owner has no authority to withdraw job funds directly.
 * Amounts are expressed in USDC base units (6 decimals). On Arc, deploy with USDC at
 * 0x3600000000000000000000000000000000000000; the token address is immutable.
 * Intended for Solidity 0.8.28, Cancun, and OpenZeppelin Contracts 5.6.1.
 */
contract ChangeBounty is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Active jobs accept funding and payouts; Cancelled jobs only allow refunds.
    enum Status { Active, Cancelled }

    /// @notice Job configuration and remaining escrow, in USDC base units.
    struct Job {
        address creator;
        address agent;
        uint128 reward;
        uint128 balance;
        uint64 createdAt;
        uint32 payouts;
        Status status;
        bytes32 urlHash;
    }

    error ZeroAddress();
    error InvalidUrlLength();
    error InvalidReward();
    error JobNotFound();
    error JobNotActive();
    error JobNotCancelled();
    error NotJobCreator();
    error NotVerifier();
    error InvalidDiscoveryId();
    error DiscoveryAlreadyPaid();
    error InsufficientJobBalance();
    error NothingToWithdraw();
    error RenounceDisabled();
    error NoVerifierProposal();
    error VerifierDelayNotElapsed(uint64 activatableAt);
    error UnexpectedFundingReceived(uint256 requested, uint256 balanceBefore, uint256 balanceAfter);

    event VerifierProposed(address indexed proposedVerifier, uint64 activatableAt);
    event VerifierProposalCancelled(address indexed proposedVerifier);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event JobCreated(
        uint256 indexed jobId,
        address indexed creator,
        address indexed agent,
        uint128 reward,
        string url,
        bytes32 urlHash
    );
    event JobFunded(uint256 indexed jobId, address indexed funder, uint128 amount, uint128 newBalance);
    event DiscoveryPaid(
        uint256 indexed jobId,
        bytes32 indexed discoveryId,
        address indexed agent,
        uint128 reward,
        address verifier
    );
    event JobCancelled(uint256 indexed jobId);
    event FundsWithdrawn(uint256 indexed jobId, address indexed creator, uint128 amount);

    /// @notice Immutable USDC token used for every job.
    IERC20 public immutable usdc;
    /// @notice Delay between proposing a verifier and being able to activate it.
    uint64 public constant VERIFIER_DELAY = 24 hours;
    /// @notice Trusted service authorized to pay discoveries.
    address public verifier;
    /// @notice Verifier waiting for activation; zero when no proposal is pending.
    address public pendingVerifier;
    /// @notice Earliest timestamp at which the pending verifier can be activated.
    uint64 public verifierActivatableAt;
    /// @notice Number of jobs created; the first job ID is 1.
    uint256 public jobCount;

    mapping(uint256 => Job) private _jobs;
    /// @notice Whether a discovery ID has already been paid for a particular job.
    mapping(uint256 => mapping(bytes32 => bool)) public paid;

    /**
     * @param usdc_ USDC ERC-20 address (6 decimals).
     * @param verifier_ Initial trusted verifier service.
     * @param owner_ Initial owner, with two-step ownership transfers thereafter.
     * @dev Ownable rejects a zero owner using its own custom error.
     */
    constructor(address usdc_, address verifier_, address owner_) Ownable(owner_) {
        if (usdc_ == address(0) || verifier_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        verifier = verifier_;
    }

    /// @notice Disabled: renouncing would make the verifier impossible to rotate.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Propose a new verifier. It becomes active only after VERIFIER_DELAY.
    /// @dev A new proposal replaces any pending one and restarts the delay. The current
    /// verifier stays authorised until activation, so the delay is a public review window.
    function proposeVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert ZeroAddress();
        uint64 activatableAt = uint64(block.timestamp) + VERIFIER_DELAY;
        pendingVerifier = newVerifier;
        verifierActivatableAt = activatableAt;
        emit VerifierProposed(newVerifier, activatableAt);
    }

    /// @notice Activate the pending verifier once the delay has elapsed.
    function activateVerifier() external onlyOwner {
        address proposed = pendingVerifier;
        if (proposed == address(0)) revert NoVerifierProposal();
        if (block.timestamp < verifierActivatableAt) revert VerifierDelayNotElapsed(verifierActivatableAt);
        address previousVerifier = verifier;
        verifier = proposed;
        pendingVerifier = address(0);
        verifierActivatableAt = 0;
        emit VerifierUpdated(previousVerifier, proposed);
    }

    /// @notice Discard a pending verifier proposal. The current verifier is unchanged.
    function cancelVerifierProposal() external onlyOwner {
        address proposed = pendingVerifier;
        if (proposed == address(0)) revert NoVerifierProposal();
        pendingVerifier = address(0);
        verifierActivatableAt = 0;
        emit VerifierProposalCancelled(proposed);
    }

    /**
     * @notice Create a monitoring job, optionally funding it immediately.
     * @dev URL length is measured in bytes. Funding below the reward, including zero,
     * is permitted. The URL is emitted; only its keccak256 hash is stored.
     * @return jobId Newly allocated job ID, starting at 1.
     */
    function createJob(
        string calldata url,
        address agent,
        uint128 reward,
        uint128 initialFunding
    ) external nonReentrant returns (uint256 jobId) {
        uint256 urlLength = bytes(url).length;
        if (urlLength == 0 || urlLength > 512) revert InvalidUrlLength();
        if (agent == address(0)) revert ZeroAddress();
        if (reward == 0) revert InvalidReward();

        jobId = ++jobCount;
        bytes32 urlHash = keccak256(bytes(url));
        _jobs[jobId] = Job({
            creator: msg.sender,
            agent: agent,
            reward: reward,
            balance: initialFunding,
            createdAt: uint64(block.timestamp),
            payouts: 0,
            status: Status.Active,
            urlHash: urlHash
        });
        emit JobCreated(jobId, msg.sender, agent, reward, url, urlHash);

        if (initialFunding != 0) {
            _pullExact(msg.sender, initialFunding);
            emit JobFunded(jobId, msg.sender, initialFunding, initialFunding);
        }
    }

    /// @notice Top up an Active job. Only the creator may fund it.
    /// @dev Escrow is refundable only to the creator, so third-party deposits would be
    /// unrecoverable by the depositor; they are rejected rather than silently captured.
    /// Zero-amount top-ups are allowed. A uint128 balance overflow reverts.
    function fundJob(uint256 jobId, uint128 amount) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.creator) revert NotJobCreator();
        if (job.status != Status.Active) revert JobNotActive();
        job.balance += amount;
        if (amount != 0) _pullExact(msg.sender, amount);
        emit JobFunded(jobId, msg.sender, amount, job.balance);
    }

    /**
     * @notice Pay one fixed reward to the configured agent for a unique discovery.
     * @dev Only the verifier may call. Discovery IDs are scoped per job, not globally.
     * The verifier cannot select the reward amount or recipient.
     */
    function payDiscovery(uint256 jobId, bytes32 discoveryId) external nonReentrant {
        if (msg.sender != verifier) revert NotVerifier();
        Job storage job = _getJob(jobId);
        if (job.status != Status.Active) revert JobNotActive();
        if (discoveryId == bytes32(0)) revert InvalidDiscoveryId();
        if (paid[jobId][discoveryId]) revert DiscoveryAlreadyPaid();
        uint128 reward = job.reward;
        if (job.balance < reward) revert InsufficientJobBalance();

        paid[jobId][discoveryId] = true;
        job.balance -= reward;
        job.payouts += 1;
        usdc.safeTransfer(job.agent, reward);
        emit DiscoveryPaid(jobId, discoveryId, job.agent, reward, msg.sender);
    }

    /// @notice Stop funding and payouts permanently without moving any funds.
    function cancelJob(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        _cancel(jobId, job);
    }

    /// @notice Refund the entire remaining balance of a Cancelled job to its creator.
    function withdrawUnused(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        _withdraw(jobId, job);
    }

    /**
     * @notice Cancel an Active job and refund its entire remaining balance atomically.
     * @dev Reverts NothingToWithdraw if empty, rolling back cancellation as well.
     * Use cancelJob to close an empty job, or withdrawUnused for an already cancelled job.
     */
    function cancelAndWithdraw(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        _cancel(jobId, job);
        _withdraw(jobId, job);
    }

    /// @notice Return all stored fields for an existing job.
    function getJob(uint256 jobId) external view returns (Job memory) {
        return _getJob(jobId);
    }

    /// @notice Return whether a discovery was paid; reverts for a nonexistent job.
    function isPaid(uint256 jobId, bytes32 discoveryId) external view returns (bool) {
        _getJob(jobId);
        return paid[jobId][discoveryId];
    }

    /// @dev Reject nonexistent IDs before interpreting default-valued job fields.
    function _getJob(uint256 jobId) private view returns (Job storage job) {
        if (jobId == 0 || jobId > jobCount) revert JobNotFound();
        return _jobs[jobId];
    }

    /// @dev Creator-only cancellation, with no external interaction.
    function _cancel(uint256 jobId, Job storage job) private {
        if (msg.sender != job.creator) revert NotJobCreator();
        if (job.status != Status.Active) revert JobNotActive();
        job.status = Status.Cancelled;
        emit JobCancelled(jobId);
    }

    /// @dev Clear escrow before transferring; caller holds the reentrancy guard.
    function _withdraw(uint256 jobId, Job storage job) private {
        if (msg.sender != job.creator) revert NotJobCreator();
        if (job.status != Status.Cancelled) revert JobNotCancelled();
        uint128 amount = job.balance;
        if (amount == 0) revert NothingToWithdraw();
        job.balance = 0;
        usdc.safeTransfer(job.creator, amount);
        emit FundsWithdrawn(jobId, job.creator, amount);
    }

    /// @dev Reject inbound fee-on-transfer behavior by checking the actual balance delta.
    function _pullExact(address funder, uint128 amount) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(funder, address(this), amount);
        uint256 afterBalance = usdc.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert UnexpectedFundingReceived(amount, beforeBalance, afterBalance);
        }
    }
}
