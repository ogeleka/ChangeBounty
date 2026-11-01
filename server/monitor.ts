import type { Hex } from 'viem'
import { readCreatedJobs, readJob, revertMessage, type CreatedJobEvent } from './chain'
import { config } from './config'
import { diffText, extractText, sha256Hex } from './extract'
import { discoveryIdFor } from './ids'
import { fetchPublicPage, UnsafeUrlError, validatePublicUrl } from './ssrf'
import { store } from './store'
import type { Discovery, MonitoredJob } from './types'
import { canRetry, verifyDiscovery } from './verifier'
import { formatUsdc } from '../src/onchain-money'

const AGENT_UA = 'ChangeBountyAgent/1.0 (website change monitor)'
const MAX_JOBS = 200
const SNIPPET_LINES = 8
const SNIPPET_CHARS = 240
const inflight = new Set<string>()

const snippet = (lines: string[]) => lines.slice(0, SNIPPET_LINES).map((l) => l.slice(0, SNIPPET_CHARS))

function setMonitoring(job: MonitoredJob, state: MonitoredJob['monitoring'], reason?: string): void {
  if (job.monitoring === state && job.monitoringReason === reason) return
  const wasActive = job.monitoring === 'active'
  job.monitoring = state
  job.monitoringReason = reason
  if (state === 'paused' && wasActive) store.addEvent(job, 'paused', `Monitoring paused: ${reason ?? 'unknown reason'}`)
  store.touch()
}

/** Why this service will not monitor a job, or null when the job is acceptable. */
export function policyViolation(ev: Pick<CreatedJobEvent, 'agent' | 'reward' | 'creator'>): string | null {
  if (!config.agentAddress) return 'This service has no agent address configured.'
  if (ev.agent.toLowerCase() !== config.agentAddress.toLowerCase()) return 'This service only monitors jobs paid to its own agent address.'
  if (ev.reward < config.minRewardRaw) return `The reward is below the minimum of ${formatUsdc(config.minRewardRaw)} USDC.`
  const mine = store.jobs().filter((j) => j.creator.toLowerCase() === ev.creator.toLowerCase() && j.monitoring === 'active').length
  if (mine >= config.maxJobsPerCreator) return `A wallet can have at most ${config.maxJobsPerCreator} active monitored jobs.`
  if (store.jobs().length >= MAX_JOBS) return 'This monitoring agent is at capacity.'
  return null
}

/** Start monitoring a job seen onchain. Idempotent. `strict` throws on policy violations (user-triggered); otherwise they are skipped. */
export async function adoptJob(ev: CreatedJobEvent, strict: boolean): Promise<MonitoredJob | null> {
  const id = ev.jobId.toString()
  const existing = store.job(id)
  if (existing) return existing
  const violation = policyViolation(ev)
  if (violation) {
    if (strict) throw new Error(violation)
    return null
  }
  const job: MonitoredJob = {
    id,
    creator: ev.creator,
    agent: ev.agent,
    url: ev.url,
    urlHash: ev.urlHash,
    rewardRaw: ev.reward.toString(),
    createTxHash: ev.txHash,
    createBlock: ev.blockNumber.toString(),
    registeredAt: Date.now(),
    monitoring: 'active',
    checks: 0,
    events: [],
  }
  store.addEvent(job, 'registered', 'Job registered with the monitoring agent.', { txHash: ev.txHash })
  try {
    await validatePublicUrl(ev.url)
  } catch (err) {
    job.monitoring = 'invalid_url'
    job.monitoringReason = err instanceof UnsafeUrlError ? err.message : 'URL could not be validated.'
    store.addEvent(job, 'error', `URL rejected: ${job.monitoringReason}`)
  }
  store.putJob(job)
  if (job.monitoring === 'active') void checkJob(job, 'register')
  return job
}

export async function registerFromTx(txHash: Hex): Promise<MonitoredJob[]> {
  const created = await readCreatedJobs(txHash)
  if (created.length === 0) throw new Error('No ChangeBounty job was created in that transaction.')
  const out: MonitoredJob[] = []
  for (const ev of created) {
    const job = await adoptJob(ev, true)
    if (job) out.push(job)
  }
  return out
}

/** One monitoring cycle for a job: refresh onchain state, fetch, hash, compare. */
export async function checkJob(job: MonitoredJob, trigger: 'poll' | 'manual' | 'register'): Promise<void> {
  if (job.monitoring === 'invalid_url' || inflight.has(job.id)) return
  inflight.add(job.id)
  try {
    const chain = await readJob(BigInt(job.id))
    if (chain.status !== 'Active') return setMonitoring(job, 'paused', 'the job is cancelled')
    if (chain.balance < chain.reward) return setMonitoring(job, 'paused', 'the job needs more USDC funding')
    setMonitoring(job, 'active')

    let text: string
    let hash: string
    try {
      const page = await fetchPublicPage(job.url, AGENT_UA)
      text = extractText(page.html)
      hash = sha256Hex(text)
      job.lastError = undefined
      job.lastCheckOk = true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Fetch failed.'
      job.lastCheckOk = false
      job.lastCheckAt = Date.now()
      job.checks += 1
      if (job.lastError !== message) store.addEvent(job, 'error', `Fetch failed: ${message}`)
      job.lastError = message
      if (err instanceof UnsafeUrlError) setMonitoring(job, 'invalid_url', message)
      store.touch()
      return
    }

    job.checks += 1
    job.lastCheckAt = Date.now()
    const at = Date.now()

    if (!job.baseline) {
      job.baseline = { hash, text, at }
      store.addEvent(job, 'baseline', `Baseline established (${hash.slice(0, 12)}). No payment for the first fetch.`)
      return
    }
    if (job.baseline.hash === hash) {
      if (trigger !== 'poll') store.addEvent(job, 'check', 'Checked the page. No change detected.')
      store.touch()
      return
    }

    // Do not stack detections while one is already being verified for this job.
    const open = store.discoveriesFor(job.id).find((d) => d.status === 'detected' || d.status === 'verifying' || d.status === 'verified')
    if (open) return

    const diff = diffText(job.baseline.text, text)
    if (diff.changedChars < config.minChangeChars) {
      job.baseline = { hash, text, at }
      store.addEvent(job, 'minor_change', `Ignored a trivial change (${diff.changedChars} characters).`)
      return
    }

    const id = discoveryIdFor(BigInt(job.id), job.baseline.hash, hash, chain.payouts)
    const prior = store.discovery(id)
    if (prior && !canRetry(prior)) return
    const discovery: Discovery = prior ?? {
      id,
      jobId: job.id,
      baselineHash: job.baseline.hash,
      newHash: hash,
      detectedAt: Date.now(),
      added: snippet(diff.added),
      removed: snippet(diff.removed),
      status: 'detected',
    }
    store.putDiscovery(discovery)
    store.addEvent(job, 'change_detected', `Meaningful change detected: ${diff.added.length} new and ${diff.removed.length} removed lines.`, { discoveryId: id })
    void verifyDiscovery(job, discovery)
  } catch (err) {
    store.addEvent(job, 'error', `Check failed: ${revertMessage(err)}`)
  } finally {
    inflight.delete(job.id)
  }
}

let loop: ReturnType<typeof setInterval> | undefined

export function startMonitor(beforeTick?: () => Promise<void>): void {
  if (loop) return
  const tick = async () => {
    try {
      await beforeTick?.()
    } catch (err) {
      console.error('[monitor] pre-tick failed:', revertMessage(err))
    }
    for (const job of store.jobs()) {
      try {
        await checkJob(job, 'poll')
      } catch (err) {
        console.error('[monitor]', job.id, revertMessage(err))
      }
    }
  }
  setTimeout(() => void tick(), 3000)
  loop = setInterval(() => void tick(), config.pollIntervalMs)
}

