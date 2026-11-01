import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'
import { redact } from './redact'
import type { Announcement, Discovery, JobEvent, JobEventType, MonitoredJob } from './types'

export interface TelegramLink {
  chatId: number
  linkedAt: number
}

export interface EmailSubscription {
  email: string
  confirmed: boolean
  confirmToken: string
  unsubscribeToken: string
  createdAt: number
  confirmedAt?: number
  lastConfirmSentAt: number
}

export interface OutboxItem {
  id: string
  /** Lowercased creator wallet. The recipient is looked up at send time, so unsubscribing cancels pending alerts. */
  address: string
  channel: 'telegram' | 'email'
  subject: string
  text: string
  attempts: number
  nextAt: number
  createdAt: number
}

export interface AlertState {
  telegram: Record<string, TelegramLink>
  email: Record<string, EmailSubscription>
  outbox: OutboxItem[]
  /** Keys of chain events already alerted on, so a rescan never alerts twice. */
  seen: string[]
  telegramOffset?: number
}

interface State {
  jobs: Record<string, MonitoredJob>
  discoveries: Record<string, Discovery>
  announcements: Announcement[]
  /** Last block scanned for contract events. Lets a restart (or a wiped disk) resume instead of rescanning. */
  cursor?: string
  alerts?: AlertState
}

type EventListener = (job: MonitoredJob, event: JobEvent) => void
const listeners: EventListener[] = []

const MAX_EVENTS = 200
// One state file per network and contract, so redeploying a contract never mixes old and new jobs.
const suffix = config.contract ? config.contract.slice(2, 10).toLowerCase() : 'nocontract'
const file = join(config.dataDir, `state-${config.network}-${suffix}.json`)

function emptyState(): State {
  return { jobs: {}, discoveries: {}, announcements: [] }
}

function load(): State {
  if (!existsSync(file)) return emptyState()
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<State>) }
  } catch {
    // Keep the unreadable file for inspection and rebuild from the chain instead of crashing.
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    console.error('[store] state file was unreadable and has been set aside. Rebuilding from chain events.')
    return emptyState()
  }
}

const state = load()
let timer: ReturnType<typeof setTimeout> | undefined
let dirty = false

function writeNow(): void {
  dirty = false
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    console.error('[store] write failed:', err instanceof Error ? redact(err.message) : 'unknown error')
  }
}

/** Debounced atomic write: temp file then rename, so a crash never leaves a half-written state file. */
function persist(): void {
  dirty = true
  timer ??= setTimeout(() => {
    timer = undefined
    writeNow()
  }, 800)
}

/** Synchronous flush for shutdown. */
function flush(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (dirty) writeNow()
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    flush()
    process.exit(0)
  })
}
process.on('beforeExit', flush)

export const store = {
  file,
  flush,
  jobs: () => Object.values(state.jobs),
  job: (id: string): MonitoredJob | undefined => state.jobs[id],
  putJob(job: MonitoredJob): void {
    state.jobs[job.id] = job
    persist()
  },
  touch(): void {
    persist()
  },
  cursor: (): bigint | undefined => (state.cursor ? BigInt(state.cursor) : undefined),
  setCursor(block: bigint): void {
    state.cursor = block.toString()
    persist()
  },
  addEvent(job: MonitoredJob, type: JobEventType, message: string, extra: Partial<JobEvent> = {}): void {
    const event: JobEvent = { t: Date.now(), type, message: redact(message, true), ...extra }
    job.events.push(event)
    if (job.events.length > MAX_EVENTS) {
      // Keep the most recent entries but never drop the first (registered) entry.
      job.events.splice(1, job.events.length - MAX_EVENTS)
    }
    persist()
    for (const listener of listeners) {
      try {
        listener(job, event)
      } catch (err) {
        console.error('[store] event listener failed:', err instanceof Error ? redact(err.message) : 'unknown error')
      }
    }
  },
  /** Called after every job event is recorded (alerts subscribe here). Listeners must not throw or block. */
  onEvent(listener: EventListener): void {
    listeners.push(listener)
  },
  alerts: (): AlertState => (state.alerts ??= { telegram: {}, email: {}, outbox: [], seen: [] }),
  discoveriesFor: (jobId: string): Discovery[] =>
    Object.values(state.discoveries)
      .filter((d) => d.jobId === jobId)
      .sort((a, b) => b.detectedAt - a.detectedAt),
  allDiscoveries: (): Discovery[] => Object.values(state.discoveries),
  discovery: (id: string): Discovery | undefined => state.discoveries[id],
  putDiscovery(d: Discovery): void {
    if (d.reason) d.reason = redact(d.reason, true)
    state.discoveries[d.id] = d
    persist()
  },
  announcements: (): Announcement[] => state.announcements,
  addAnnouncement(a: Announcement): void {
    state.announcements.unshift(a)
    state.announcements = state.announcements.slice(0, 50)
    persist()
  },
}
