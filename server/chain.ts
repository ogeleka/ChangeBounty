import { createPublicClient, createWalletClient, http, parseEventLogs, parseUnits, type Address, type Hex, type Log } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { changeBountyAbi, JOB_STATUS } from '../src/contracts/changeBounty'
import { requireChain } from '../src/onchain-facts'
import { config } from './config'
import { redact } from './redact'
import type { ChainJobView } from './types'

export const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }) })

const account = config.verifierKey ? privateKeyToAccount(config.verifierKey) : null
const walletClient = account ? createWalletClient({ account, chain: config.chain, transport: http(config.rpcUrl, { timeout: 20_000 }) }) : null

export interface OnchainJob {
  creator: Address
  agent: Address
  reward: bigint
  balance: bigint
  payouts: number
  status: ChainJobView['status']
}

export function requireContract(): Address {
  if (!config.contract) throw new Error('VITE_CHANGEBOUNTY_ADDRESS is not configured.')
  return config.contract
}

export async function readJob(jobId: bigint): Promise<OnchainJob> {
  const job = await publicClient.readContract({ address: requireContract(), abi: changeBountyAbi, functionName: 'getJob', args: [jobId] })
  return {
    creator: job.creator,
    agent: job.agent,
    reward: job.reward,
    balance: job.balance,
    payouts: job.payouts,
    status: job.status === JOB_STATUS.Active ? 'Active' : 'Cancelled',
  }
}

export interface CreatedJobEvent {
  jobId: bigint
  creator: Address
  agent: Address
  reward: bigint
  url: string
  urlHash: Hex
  txHash: Hex
  blockNumber: bigint
}

type CreatedLog = Log & { args: { jobId: bigint; creator: Address; agent: Address; reward: bigint; url: string; urlHash: Hex } }

export function toCreatedEvent(l: CreatedLog): CreatedJobEvent {
  return {
    jobId: l.args.jobId,
    creator: l.args.creator,
    agent: l.args.agent,
    reward: l.args.reward,
    url: l.args.url,
    urlHash: l.args.urlHash,
    txHash: l.transactionHash as Hex,
    blockNumber: l.blockNumber ?? 0n,
  }
}

/** Decode every JobCreated event our contract emitted in a confirmed transaction. */
export async function readCreatedJobs(txHash: Hex): Promise<CreatedJobEvent[]> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('That transaction reverted.')
  const contract = requireContract().toLowerCase()
  const logs = parseEventLogs({ abi: changeBountyAbi, eventName: 'JobCreated', logs: receipt.logs.filter((l) => l.address.toLowerCase() === contract) })
  return logs.map((l) => toCreatedEvent(l as unknown as CreatedLog))
}

export interface PayoutResult {
  txHash: Hex
  blockNumber: bigint
  reward: bigint
}

function paymentFromLogs(logs: Log[], discoveryId: Hex): { reward: bigint } | undefined {
  const address = requireContract().toLowerCase()
  const events = parseEventLogs({ abi: changeBountyAbi, eventName: 'DiscoveryPaid', logs: logs.filter((l) => l.address.toLowerCase() === address) })
  const found = events.find((e) => e.args.discoveryId.toLowerCase() === discoveryId.toLowerCase())
  return found ? { reward: found.args.reward } : undefined
}

/** Verifier transactions are serialised so nonces never collide. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Pay one discovery. `onSent` fires the moment the transaction is broadcast, so the caller can persist
 * the hash before waiting for the receipt and recover it after a crash or a timeout.
 */
export function payDiscoveryOnchain(jobId: bigint, discoveryId: Hex, onSent: (hash: Hex) => void): Promise<PayoutResult> {
  const run = async (): Promise<PayoutResult> => {
    if (!walletClient || !account) throw new Error('Verifier key is not configured on the server.')
    const address = requireContract()
    // Simulate first: surfaces a precise revert reason (duplicate, cancelled, unfunded) without spending gas.
    const { request } = await publicClient.simulateContract({ address, abi: changeBountyAbi, functionName: 'payDiscovery', args: [jobId, discoveryId], account })
    const txHash = await walletClient.writeContract(request)
    onSent(txHash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
    if (receipt.status !== 'success') throw new Error('The payout transaction reverted.')
    const paid = paymentFromLogs(receipt.logs, discoveryId)
    if (!paid) throw new Error('Transaction succeeded but no DiscoveryPaid event was found.')
    return { txHash, blockNumber: receipt.blockNumber, reward: paid.reward }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

export async function isDiscoveryPaid(jobId: bigint, discoveryId: Hex): Promise<boolean> {
  return publicClient.readContract({ address: requireContract(), abi: changeBountyAbi, functionName: 'isPaid', args: [jobId, discoveryId] })
}

/** Look up a broadcast payout by hash. Returns undefined while it is still pending or if it is unknown. */
export async function payoutFromTx(txHash: Hex, discoveryId: Hex): Promise<PayoutResult | 'reverted' | undefined> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') return 'reverted'
    const paid = paymentFromLogs(receipt.logs, discoveryId)
    return paid ? { txHash, blockNumber: receipt.blockNumber, reward: paid.reward } : 'reverted'
  } catch {
    return undefined
  }
}

/** Find the transaction that paid a discovery by reading DiscoveryPaid events for exactly that (job, discovery). */
export async function findPayoutByEvent(jobId: bigint, discoveryId: Hex, fromBlock: bigint): Promise<PayoutResult | undefined> {
  const logs = await publicClient.getContractEvents({
    address: requireContract(),
    abi: changeBountyAbi,
    eventName: 'DiscoveryPaid',
    args: { jobId, discoveryId },
    fromBlock,
    toBlock: 'latest',
  })
  const log = logs[0]
  if (!log || !log.transactionHash) return undefined
  return { txHash: log.transactionHash, blockNumber: log.blockNumber ?? 0n, reward: log.args.reward ?? 0n }
}

/** True when the verifier wallet holds enough native USDC (18-decimal gas view) for several payouts. */
export async function verifierHasGas(): Promise<boolean> {
  if (!account) return false
  const balance = await publicClient.getBalance({ address: account.address })
  return balance >= parseUnits('0.02', requireChain(config.chainId).nativeCurrency.decimals)
}

/** Message safe to store or show: first line only, with URLs, tokens and key-shaped values removed. */
export function revertMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error.'
  const short = (err as { shortMessage?: string }).shortMessage
  return redact((short ?? err.message).split('\n')[0]).slice(0, 300)
}
