import type { Hex } from 'viem'
import { changeBountyAbi } from '../src/contracts/changeBounty'
import { publicClient, requireContract, revertMessage, toCreatedEvent } from './chain'
import { onVerifierProposed } from './alerts'
import { config } from './config'
import { adoptJob } from './monitor'
import { store } from './store'
import type { Discovery, SyncStatus } from './types'

/**
 * Rebuilds and keeps the job registry in step with the chain, so a wiped disk, a failed browser
 * registration call or a restart never leaves a funded job unmonitored or a payment missing from
 * history. Scans forward from a stored cursor, never from block 0: the first run starts at the block
 * the contract was deployed in (VITE_CHANGEBOUNTY_DEPLOY_TX), or a bounded lookback if that is unset.
 */

const FALLBACK_LOOKBACK = 5_000n
const MAX_BATCH = 5_000n
const MIN_BATCH = 250n
const REORG_MARGIN = 10n

let batch = MAX_BATCH
let running = false
let startBlock: bigint | undefined

export const syncStatus: SyncStatus = { state: config.contract ? 'idle' : 'disabled' }

async function resolveStartBlock(head: bigint): Promise<bigint> {
  if (startBlock !== undefined) return startBlock
  if (config.contractDeployTx) {
    try {
      startBlock = (await publicClient.getTransactionReceipt({ hash: config.contractDeployTx })).blockNumber
      return startBlock
    } catch {
      console.warn('[sync] could not read the deployment transaction; using a bounded lookback.')
    }
  } else {
    console.warn('[sync] VITE_CHANGEBOUNTY_DEPLOY_TX is not set; first scan covers only the most recent blocks.')
  }
  startBlock = head > FALLBACK_LOOKBACK ? head - FALLBACK_LOOKBACK : 0n
  return startBlock
}

function adoptPayment(jobId: string, discoveryId: Hex, txHash: Hex, blockNumber: bigint, reward: bigint): void {
  const job = store.job(jobId)
  const existing = store.discovery(discoveryId)
  if (existing?.status === 'paid' && existing.txHash) return
  const d: Discovery = existing ?? {
    id: discoveryId,
    jobId,
    baselineHash: '',
    newHash: '',
    detectedAt: Date.now(),
    added: [],
    removed: [],
    status: 'paid',
  }
  d.status = 'paid'
  d.txHash = txHash
  d.blockNumber = blockNumber.toString()
  d.rewardRaw = reward.toString()
  d.paidAt = d.paidAt ?? Date.now()
  d.pendingTx = undefined
  d.reason = existing ? d.reason : 'Recovered from onchain events.'
  store.putDiscovery(d)
  if (job && !existing) store.addEvent(job, 'paid', 'Payment recovered from onchain events.', { txHash, discoveryId })
}

/** One incremental pass. Safe to call repeatedly; concurrent calls are ignored. */
export async function syncFromChain(): Promise<void> {
  if (!config.contract || running) return
  running = true
  syncStatus.state = 'syncing'
  try {
    const address = requireContract()
    const head = await publicClient.getBlockNumber()
    const cursor = store.cursor()
    let from = cursor !== undefined ? (cursor > REORG_MARGIN ? cursor - REORG_MARGIN : 0n) : await resolveStartBlock(head)
    while (from <= head) {
      const to = from + batch - 1n > head ? head : from + batch - 1n
      try {
        const logs = await publicClient.getLogs({
          address,
          events: [
            changeBountyAbi.find((i) => i.type === 'event' && i.name === 'JobCreated')!,
            changeBountyAbi.find((i) => i.type === 'event' && i.name === 'DiscoveryPaid')!,
            changeBountyAbi.find((i) => i.type === 'event' && i.name === 'VerifierProposed')!,
          ],
          fromBlock: from,
          toBlock: to,
        })
        for (const log of logs) {
          if (log.eventName === 'JobCreated') {
            await adoptJob(toCreatedEvent(log as unknown as Parameters<typeof toCreatedEvent>[0]), false)
          } else if (log.eventName === 'DiscoveryPaid') {
            const a = log.args as { jobId: bigint; discoveryId: Hex; reward: bigint }
            adoptPayment(a.jobId.toString(), a.discoveryId, log.transactionHash as Hex, log.blockNumber ?? 0n, a.reward)
          } else if (log.eventName === 'VerifierProposed') {
            const a = log.args as { proposedVerifier: string; activatableAt: bigint }
            onVerifierProposed(a.proposedVerifier, a.activatableAt, `verifier-proposed:${log.transactionHash}:${log.logIndex}`)
          }
        }
        store.setCursor(to)
        from = to + 1n
        if (batch < MAX_BATCH) batch = batch * 2n > MAX_BATCH ? MAX_BATCH : batch * 2n
      } catch (err) {
        // The RPC refused this range (too large or too many results): shrink and retry the same range.
        if (batch <= MIN_BATCH) throw err
        batch = batch / 2n < MIN_BATCH ? MIN_BATCH : batch / 2n
      }
    }
    syncStatus.state = 'idle'
    syncStatus.lastError = undefined
    syncStatus.headBlock = head.toString()
    syncStatus.cursorBlock = (store.cursor() ?? head).toString()
    syncStatus.blocksBehind = (head - (store.cursor() ?? head)).toString()
  } catch (err) {
    syncStatus.state = 'error'
    syncStatus.lastError = revertMessage(err)
    console.error('[sync]', syncStatus.lastError)
  } finally {
    syncStatus.lastRunAt = Date.now()
    running = false
  }
}
