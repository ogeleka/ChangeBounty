import { randomBytes } from 'node:crypto'
import { config } from '../config'
import { redact } from '../redact'
import { store } from '../store'
import type { JobEvent, MonitoredJob, Subscription } from '../types'
import { confirmEmail, jobUrl, render, shouldNotify } from './templates'
import { buildTransport, DeliveryError, type TelegramUpdate, type Transport } from './transports'

/**
 * Alerts for people watching a job. Two channels:
 *  - Email through Resend, with double opt-in and one-click unsubscribe.
 *  - Telegram through a bot: the job page gives a one-time deep link; pressing Start in Telegram binds
 *    that chat to the job. Updates are collected by long polling, so no public webhook is needed.
 * Subscriber addresses live only in the server state file and are never returned by any API.
 */

export class NotifyError extends Error {}

let transport: Transport = {}
let pacingMs = 600
let polling = false

export function setTransport(t: Transport): void {
  transport = t
}
export function setPacing(ms: number): void {
  pacingMs = ms
}
export const notificationInfo = () => ({ email: Boolean(transport.email), telegramBot: transport.telegram?.botUsername ?? null })

const newToken = () => randomBytes(24).toString('base64url')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const DAY = 86_400_000

// ---------- email address handling ----------

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/

/** Lowercased address, or null. Whitespace, control characters and header-injection tricks cannot match. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length > 254 || email.includes('..') || !EMAIL_RE.test(email)) return null
  return email
}

const confirmSends = new Map<string, number[]>()
/** At most 3 confirmation emails per address per day, so this cannot be used to spam someone. */
function allowConfirm(email: string): boolean {
  const now = Date.now()
  const recent = (confirmSends.get(email) ?? []).filter((t) => now - t < DAY)
  if (recent.length >= 3) return false
  recent.push(now)
  confirmSends.set(email, recent)
  return true
}

const confirmUrl = (s: Subscription) => `${config.publicBaseUrl}/api/notify/confirm?token=${s.token}`
const unsubUrl = (s: Subscription) => `${config.publicBaseUrl}/api/notify/unsubscribe?token=${s.token}`

// ---------- subscriptions ----------

function activeFor(jobId: string): Subscription[] {
  return store.subscriptions().filter((s) => s.jobId === jobId && s.status === 'active')
}

/** Starts email double opt-in. Returns quietly for repeats so the response never reveals who is subscribed. */
export async function requestEmailSubscription(jobId: string, rawEmail: unknown): Promise<void> {
  const job = store.job(jobId)
  if (!job) throw new NotifyError('Job not found.')
  if (!transport.email) throw new NotifyError('Email alerts are not enabled on this server.')
  const email = normaliseEmail(rawEmail)
  if (!email) throw new NotifyError('Enter a valid email address.')

  const mine = store.subscriptions().filter((s) => s.jobId === jobId)
  const existing = mine.find((s) => s.channel === 'email' && s.target === email)
  if (existing?.status === 'active') return
  if (!existing && mine.length >= config.maxSubscribersPerJob) throw new NotifyError('This job has reached its subscriber limit.')
  if (existing?.lastConfirmSentAt && Date.now() - existing.lastConfirmSentAt < 10 * 60_000) return
  if (!allowConfirm(email)) return

  const sub: Subscription = existing ?? {
    id: randomBytes(8).toString('hex'),
    jobId,
    channel: 'email',
    target: email,
    status: 'pending',
    token: newToken(),
    createdAt: Date.now(),
  }
  sub.lastConfirmSentAt = Date.now()
  store.putSubscription(sub)

  const msg = confirmEmail(job, confirmUrl(sub), unsubUrl(sub))
  try {
    await transport.email.send({ to: email, ...msg, unsubscribeUrl: unsubUrl(sub) })
  } catch {
    if (!existing) store.deleteSubscription(sub.id)
    throw new NotifyError('Could not send the confirmation email. Please try again later.')
  }
}

export function confirmSubscription(token: string): Subscription | null {
  const sub = store.subscriptions().find((s) => s.token === token)
  if (!sub) return null
  if (sub.status === 'pending') {
    if (Date.now() - sub.createdAt > 7 * DAY) return null
    sub.status = 'active'
    sub.confirmedAt = Date.now()
    store.putSubscription(sub)
  }
  return sub
}

export function unsubscribe(token: string): Subscription | null {
  const sub = store.subscriptions().find((s) => s.token === token)
  if (!sub) return null
  store.deleteSubscription(sub.id)
  return sub
}

// ---------- Telegram ----------

const links = new Map<string, { jobId: string; exp: number }>()

/** One-time deep link. The token only proves "this person asked for job N"; it carries no secret. */
export function createTelegramLink(jobId: string): string {
  if (!store.job(jobId)) throw new NotifyError('Job not found.')
  const bot = transport.telegram?.botUsername
  if (!bot) throw new NotifyError('Telegram alerts are not enabled on this server.')
  if (activeFor(jobId).length >= config.maxSubscribersPerJob) throw new NotifyError('This job has reached its subscriber limit.')
  if (links.size > 500) sweep()
  const token = newToken()
  links.set(token, { jobId, exp: Date.now() + 30 * 60_000 })
  return `https://t.me/${bot}?start=${token}`
}

async function reply(chatId: string, text: string): Promise<void> {
  try {
    await transport.telegram?.send(chatId, text)
  } catch {
    /* the user may have blocked the bot; nothing to do */
  }
}

const HELP = 'ChangeBounty alerts.\n\nOpen a job page on the ChangeBounty site and press "Telegram alerts" to link this chat to that job.\n\nCommands:\n/status - list the jobs this chat follows\n/stop - stop all alerts'

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.text || msg.chat.type !== 'private') return
  const chatId = String(msg.chat.id)
  const [cmdRaw = '', arg] = msg.text.trim().split(/\s+/)
  const cmd = cmdRaw.split('@')[0].toLowerCase()
  const mine = store.subscriptions().filter((s) => s.channel === 'telegram' && s.target === chatId)

  if (cmd === '/stop') {
    mine.forEach((s) => store.deleteSubscription(s.id))
    return reply(chatId, mine.length > 0 ? 'Done. You will not receive any more ChangeBounty alerts in this chat.' : 'You have no active alerts here.')
  }
  if (cmd === '/status' || cmd === '/list') {
    return reply(chatId, mine.length > 0 ? `You follow: ${mine.map((s) => `job #${s.jobId}`).join(', ')}.\nSend /stop to unsubscribe.` : 'You have no active alerts here.')
  }
  if (cmd !== '/start' || !arg) return reply(chatId, HELP)

  const link = links.get(arg)
  if (!link || link.exp < Date.now()) return reply(chatId, 'That link has expired. Open the job page and press "Telegram alerts" again.')
  links.delete(arg)
  const job = store.job(link.jobId)
  if (!job) return reply(chatId, 'That job no longer exists.')
  if (mine.some((s) => s.jobId === job.id)) return reply(chatId, `You already follow job #${job.id}.`)
  if (mine.length >= 10) return reply(chatId, 'This chat already follows 10 jobs. Send /stop to clear them first.')
  if (activeFor(job.id).length >= config.maxSubscribersPerJob) return reply(chatId, 'This job has reached its subscriber limit.')

  store.putSubscription({ id: randomBytes(8).toString('hex'), jobId: job.id, channel: 'telegram', target: chatId, status: 'active', token: newToken(), createdAt: Date.now(), confirmedAt: Date.now() })
  return reply(chatId, `Subscribed. You will get alerts for job #${job.id}:\n${jobUrl(job)}\n\nSend /stop to unsubscribe.`)
}

async function pollLoop(): Promise<void> {
  let offset = 0
  let lastLogged = ''
  while (polling && transport.telegram) {
    try {
      for (const u of await transport.telegram.getUpdates(offset, 25)) {
        offset = u.update_id + 1
        await handleTelegramUpdate(u).catch(() => undefined)
      }
    } catch (err) {
      const message = err instanceof DeliveryError ? err.message : 'unexpected error'
      if (message !== lastLogged) console.error('[notify] Telegram polling:', message)
      lastLogged = message
      await sleep(5000)
    }
  }
}

// ---------- delivery ----------

const queue: Array<() => Promise<void>> = []
let pumping: Promise<void> | null = null

function pump(): Promise<void> {
  pumping ??= (async () => {
    try {
      for (let task = queue.shift(); task; task = queue.shift()) await task().catch(() => undefined)
    } finally {
      pumping = null
    }
  })()
  return pumping
}

/** Resolves when every queued notification has been attempted. */
export const drain = (): Promise<void> => pumping ?? Promise.resolve()

async function deliver(sub: Subscription, job: MonitoredJob, event: JobEvent): Promise<void> {
  const rendered = render(job, event, sub.channel === 'email' ? unsubUrl(sub) : undefined)
  if (!rendered) return
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (sub.channel === 'email' && transport.email) {
        await transport.email.send({ to: sub.target, subject: rendered.subject, text: rendered.text, html: rendered.html, unsubscribeUrl: unsubUrl(sub) })
        if (pacingMs > 0) await sleep(pacingMs)
      } else if (sub.channel === 'telegram' && transport.telegram) {
        await transport.telegram.send(sub.target, rendered.telegram)
      } else {
        return
      }
      return
    } catch (err) {
      if (err instanceof DeliveryError && err.permanent && sub.channel === 'telegram') {
        store.deleteSubscription(sub.id)
        return
      }
      if (attempt === 3) {
        console.error(`[notify] ${sub.channel} delivery failed for job ${job.id}:`, redact(err instanceof Error ? err.message : 'error'))
        return
      }
      if (pacingMs > 0) await sleep(attempt * 3000)
    }
  }
}

/** Called for every job event. Fire-and-forget: it can never slow or break monitoring. */
export function dispatchEvent(job: MonitoredJob, event: JobEvent): void {
  if (!shouldNotify(event)) return
  for (const sub of activeFor(job.id)) {
    const key = `${sub.id}:${event.type}:${event.discoveryId ?? event.t}`
    if (!store.markSent(key)) continue
    if (queue.length >= 1000) {
      console.error('[notify] queue full; dropping a notification')
      return
    }
    queue.push(() => deliver(sub, job, event))
  }
  if (queue.length > 0) void pump()
}

/** Drops unconfirmed subscriptions after 7 days and expired Telegram links. */
export function sweep(): void {
  const now = Date.now()
  for (const s of store.subscriptions()) if (s.status === 'pending' && now - s.createdAt > 7 * DAY) store.deleteSubscription(s.id)
  for (const [token, l] of links) if (l.exp < now) links.delete(token)
}

export async function initNotifications(custom?: Transport): Promise<void> {
  transport = custom ?? (await buildTransport())
  store.onEvent(dispatchEvent)
  if (transport.telegram) {
    polling = true
    void pollLoop()
  }
  setInterval(sweep, 3_600_000).unref()
  console.log(`[notify] email ${transport.email ? 'on' : 'off'}, telegram ${transport.telegram ? `on (@${transport.telegram.botUsername})` : 'off'}`)
}

export function stopNotifications(): void {
  polling = false
}

