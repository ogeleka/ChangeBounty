import type { Hex } from 'viem'
import {
  findPayoutByEvent,
  isDiscoveryPaid,
  payDiscoveryOnchain,
  payoutFromTx,
  publicClient,
  readJob,
  revertMessage,
  type PayoutResult,
} from './chain'
import { config } from './config'
import { diffText, extractText, sha256Hex } from './extract'
import { discoveryIdFor } from './ids'
import { fetchPublicPage } from './ssrf'
import { store } from './store'
import type { Discovery, MonitoredJob } from './types'

/**
 * The verifier is the only component that holds the key allowed to call `payDiscovery`.
 *
 * It does not trust the monitoring agent's claim. It waits, fetches the page itself with its own
 * identity, re-extracts the text, and only authorises a payment when:
 *   1. its own page hash equals the hash the agent reported (the change is real and stable),
 *   2. that hash differs from the agreed baseline and the text difference is meaningful,
 *   3. the discovery id matches (job, baseline, new content, payouts so far) as recomputed from chain state,
 *   4. the job is still active and funded onchain and this discovery has not been paid.
 *
 * Trust note: this is a trusted service. The contract bounds the damage of a compromised verifier
 * to fixed rewards from funded, active jobs.
 */

const VERIFIER_UA = 'ChangeBountyVerifier/1.0 (independent verification)'
const MAX_ATTEMPTS = 3
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const canRetry = (d: Discovery): boolean => (d.status === 'failed' || d.status === 'rejected') && (d.attempts ?? 0) < MAX_ATTEMPTS

function reject(job: MonitoredJob, d: Discovery, reason: string): void {
  d.status = 'rejected'
  d.reason = reason
  store.putDiscovery(d)
  store.addEvent(job, 'rejected', `Verifier rejected the discovery: ${reason}`, { discoveryId: d.id })
}

function markPaid(job: MonitoredJob, d: Discovery, r: Pick<PayoutResult, 'txHash' | 'blockNumber' | 'reward'> | undefined, note?: string): void {
  d.status = 'paid'
  d.paidAt = Date.now()
  d.reason = note
  if (r) {
    d.txHash = r.txHash
    d.blockNumber = r.blockNumber.toString()
    d.rewardRaw = r.reward.toString()
  }
  d.pendingTx = undefined
  store.putDiscovery(d)
  store.addEvent(job, 'paid', note ?? 'USDC reward paid to the agent onchain.', { txHash: r?.txHash, discoveryId: d.id })
}

async function createBlockOf(job: MonitoredJob): Promise<bigint> {
  if (job.createBlock) return BigInt(job.createBlock)
  const receipt = await publicClient.getTransactionReceipt({ hash: job.createTxHash as Hex })
  job.createBlock = receipt.blockNumber.toString()
  store.touch()
  return receipt.blockNumber
}

/**
 * If a payout actually landed onchain (even though we lost track of it through a timeout, a crash or a
 * dropped connection), record it with its real transaction hash. Never sends a transaction.
 */
export async function settleIfPaid(job: MonitoredJob, d: Discovery): Promise<boolean> {
  try {
    if (d.pendingTx) {
      const r = await payoutFromTx(d.pendingTx as Hex, d.id as Hex)
      if (r && r !== 'reverted') {
        markPaid(job, d, r)
        return true
      }
    }
    if (await isDiscoveryPaid(BigInt(job.id), d.id as Hex)) {
      const found = await findPayoutByEvent(BigInt(job.id), d.id as Hex, await createBlockOf(job)).catch(() => undefined)
      markPaid(job, d, found, found ? undefined : 'Paid onchain. The transaction hash could not be located.')
      return true
    }
  } catch {
    /* fall through: could not confirm either way */
  }
  return false
}

export async function verifyDiscovery(job: MonitoredJob, d: Discovery): Promise<void> {
  d.attempts = (d.attempts ?? 0) + 1
  d.status = 'verifying'
  d.reason = undefined
  store.putDiscovery(d)
  store.addEvent(job, 'verifying', 'Verifier is independently re-fetching the page.', { discoveryId: d.id })
  const previousBaseline = job.baseline

  try {
    await sleep(config.verifyDelayMs)

    // Independent fetch with the verifier's own identity.
    const page = await fetchPublicPage(job.url, VERIFIER_UA)
    const text = extractText(page.html)
    const hash = sha256Hex(text)
    d.verifierHash = hash

    if (hash === d.baselineHash) return reject(job, d, 'The page matches the baseline again. The change did not persist.')
    if (hash !== d.newHash) return reject(job, d, 'The verifier saw different content than the agent reported. The page is still changing.')
    const baselineText = job.baseline?.hash === d.baselineHash ? job.baseline.text : undefined
    if (baselineText !== undefined && diffText(baselineText, text).changedChars < config.minChangeChars) {
      return reject(job, d, 'The difference is too small to count as a meaningful change.')
    }

    const id = d.id as Hex
    const jobId = BigInt(job.id)
    const chain = await readJob(jobId)
    if (chain.status !== 'Active') return reject(job, d, 'The job is cancelled onchain.')
    if (chain.balance < chain.reward) return reject(job, d, 'The job no longer has enough USDC to pay the reward.')
    if (discoveryIdFor(jobId, d.baselineHash, d.newHash, chain.payouts) !== id) {
      return reject(job, d, 'The onchain payout count changed since detection. The change will be re-evaluated.')
    }

    d.status = 'verified'
    d.verifiedAt = Date.now()
    store.putDiscovery(d)
    store.addEvent(job, 'verified', 'Verifier confirmed the change independently. Authorising payment.', { discoveryId: d.id })

    // Space payouts per job so a flapping page cannot drain gas or escrow quickly.
    const last = store.discoveriesFor(job.id).find((x) => x.status === 'paid' && x.paidAt)
    const wait = last?.paidAt ? last.paidAt + config.payoutCooldownMs - Date.now() : 0
    if (wait > 0) await sleep(Math.min(wait, config.payoutCooldownMs))

    // The agreed new baseline is set before payment so a slow transaction cannot cause a second detection.
    job.baseline = { hash, text, at: Date.now() }
    store.touch()

    if (await isDiscoveryPaid(jobId, id)) {
      if (await settleIfPaid(job, d)) return
    }

    const result = await payDiscoveryOnchain(jobId, id, (hash) => {
      d.pendingTx = hash
      store.putDiscovery(d)
      store.addEvent(job, 'verified', 'Payout transaction broadcast. Waiting for confirmation.', { txHash: hash, discoveryId: d.id })
    })
    markPaid(job, d, result)
  } catch (err) {
    // The payout may have landed even though we never saw the receipt.
    if (await settleIfPaid(job, d)) return
    // Not paid: put the old baseline back so the next cycle sees the change again and can retry.
    if (previousBaseline && d.status === 'verified') job.baseline = previousBaseline
    const message = revertMessage(err)
    d.status = 'failed'
    d.reason = message
    store.putDiscovery(d)
    store.addEvent(job, 'error', `Verification or payment failed: ${message}`, { discoveryId: d.id })
  }
}

/**
 * Called once at startup. Anything left mid-flight by a crash or restart is settled from chain state:
 * paid ones get their real transaction hash, unpaid ones are verified again (never paid twice: the
 * contract and an isPaid check both refuse duplicates).
 */
export async function recoverInterrupted(): Promise<void> {
  for (const d of store.allDiscoveries()) {
    if (d.status !== 'detected' && d.status !== 'verifying' && d.status !== 'verified') continue
    const job = store.job(d.jobId)
    if (!job) continue
    if (d.pendingTx) {
      // A broadcast transaction may still be pending: give it a chance to land before deciding.
      await publicClient.waitForTransactionReceipt({ hash: d.pendingTx as Hex, timeout: 60_000 }).catch(() => undefined)
    }
    if (await settleIfPaid(job, d)) continue
    if ((d.attempts ?? 0) >= MAX_ATTEMPTS) {
      d.status = 'failed'
      d.reason = 'Interrupted by a restart and out of attempts.'
      store.putDiscovery(d)
      continue
    }
    store.addEvent(job, 'verifying', 'Resuming an interrupted verification after a restart.', { discoveryId: d.id })
    void verifyDiscovery(job, d)
  }
}
