import { parseAbi } from 'viem'

/** ChangeBounty external ABI (human-readable). Shared by the browser app and the server. */
export const changeBountyAbi = parseAbi([
  'constructor(address usdc_, address verifier_, address owner_)',
  'function usdc() view returns (address)',
  'function verifier() view returns (address)',
  'function owner() view returns (address)',
  'function jobCount() view returns (uint256)',
  'function paid(uint256 jobId, bytes32 discoveryId) view returns (bool)',
  'function isPaid(uint256 jobId, bytes32 discoveryId) view returns (bool)',
  'function getJob(uint256 jobId) view returns ((address creator, address agent, uint128 reward, uint128 balance, uint64 createdAt, uint32 payouts, uint8 status, bytes32 urlHash))',
  'function createJob(string url, address agent, uint128 reward, uint128 initialFunding) returns (uint256 jobId)',
  'function fundJob(uint256 jobId, uint128 amount)',
  'function payDiscovery(uint256 jobId, bytes32 discoveryId)',
  'function cancelJob(uint256 jobId)',
  'function withdrawUnused(uint256 jobId)',
  'function cancelAndWithdraw(uint256 jobId)',
  'function setVerifier(address newVerifier)',
  'event JobCreated(uint256 indexed jobId, address indexed creator, address indexed agent, uint128 reward, string url, bytes32 urlHash)',
  'event JobFunded(uint256 indexed jobId, address indexed funder, uint128 amount, uint128 newBalance)',
  'event DiscoveryPaid(uint256 indexed jobId, bytes32 indexed discoveryId, address indexed agent, uint128 reward, address verifier)',
  'event JobCancelled(uint256 indexed jobId)',
  'event FundsWithdrawn(uint256 indexed jobId, address indexed creator, uint128 amount)',
  'error ZeroAddress()',
  'error InvalidUrlLength()',
  'error InvalidReward()',
  'error JobNotFound()',
  'error JobNotActive()',
  'error JobNotCancelled()',
  'error NotJobCreator()',
  'error NotVerifier()',
  'error InvalidDiscoveryId()',
  'error DiscoveryAlreadyPaid()',
  'error InsufficientJobBalance()',
  'error NothingToWithdraw()',
  'error RenounceDisabled()',
])

/** Mirrors `enum Status { Active, Cancelled }`. */
export const JOB_STATUS = { Active: 0, Cancelled: 1 } as const
