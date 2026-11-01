import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'
import { redact } from './redact'
import type { Announcement, Discovery, JobEvent, JobEventType, MonitoredJob, Subscription } from './types'

interface State {
  jobs: Record<string, MonitoredJob>
  discoveries: Record<string, Discovery>
  announcements: Announcement[]
  /** Notification subscribers. Contains email addresses: never exposed through the API. */
  subscriptions: Record<string, Subscription>
  /** Keys of notifications already delivered, so a restart or a retry never sends one twice. */
  notifySent: string[]
  /** Last block scanned for contract events. Lets a restart (or a wiped disk) resume instead of rescanning. */
  cursor?: string
}

const MAX_EVENTS = 200
// One state file per network and contract, so redeploying a contract never mixes old and new jobs.
const suffix = config.contract ? config.contract.slice(2, 10).toLowerCase() : 'nocontract'
const file = join(config.dataDir, `state-${config.network}-${suffix}.json`)

function emptyState(): State {
  return { jobs: {}, discoveries: {}, announcements: [], subscriptions: {}, notifySent: [] }
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

type EventListener = (job: MonitoredJob, event: JobEvent) => void
const listeners = new Set<EventListener>()

export const store = {
  onEvent(fn: EventListener): void {
    listeners.add(fn)
  },
  subscriptions: (): Subscription[] => Object.values(state.subscriptions),
  subscription: (id: string): Subscription | undefined => state.subscriptions[id],
  putSubscription(s: Subscription): void {
    state.subscriptions[s.id] = s
    persist()
  },
  deleteSubscription(id: string): void {
    delete state.subscriptions[id]
    persist()
  },
  /** Returns true the first time a key is seen, false if that notification was already delivered. */
  markSent(key: string): boolean {
    if (state.notifySent.includes(key)) return false
    state.notifySent.push(key)
    if (state.notifySent.length > 3000) state.notifySent.splice(0, state.notifySent.length - 3000)
    persist()
    return true
  },
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
    for (const fn of listeners) {
      try {
        fn(job, event)
      } catch {
        /* a notification problem must never break monitoring */
      }
    }
    if (job.events.length > MAX_EVENTS) {
      // Keep the most recent entries but never drop the first (registered) entry.
      job.events.splice(1, job.events.length - MAX_EVENTS)
    }
    persist()
  },
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
