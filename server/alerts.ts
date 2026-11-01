import { randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { isValidEmail, normaliseEmail, type AlertAction } from '../src/lib/alertMessage'
import { AlertError, jobEventAlert, parseSignedFields, signatureMatches, verifierProposedAlert, type Alert, type SignedFields } from './alertText'
import { publicClient } from './chain'
import { config } from './config'
import { emailEnabled, sendEmail } from './email'
import { redact } from './redact'
import { store, type EmailSubscription } from './store'
import { sendTelegram, startTelegram, telegram, TelegramError } from './telegram'
import type { AlertStatus, JobEvent, MonitoredJob } from './types'

/**
 * Telegram and email alerts for job creators (docs/NOTIFICATIONS.md).
 *
 * - Subscribing needs a signature from the wallet that created a monitored job; email is double opt-in.
 * - Alerts come from job events (store.onEvent) and from chain events (verifier proposals).
 * - Every alert goes through a persisted outbox with retries. Sending never blocks monitoring or payouts.
 * - Chat ids and email addresses stay on this server: never onchain, never in public API responses.
 */

export { AlertError }

const LINK_CODE_TTL_MS = 15 * 60_000
const MAX_ALERTS_PER_JOB_PER_HOUR = 10
const FETCH_ALERT_GAP_MS = 6 * 3600_000
const CONFIRM_RESEND_GAP_MS = 2 * 60_000
const MAX_CONFIRMS_PER_EMAIL_PER_DAY = 3
const MAX_CONFIRMS_PER_HOUR = 50
const MAX_ATTEMPTS = 6
const MAX_OUTBOX = 2000
const MAX_SEEN = 500
const OUTBOX_TTL_MS = 24 * 3600_000

const token = () => randomBytes(24).toString('base64url')
const key = (address: string) => address.toLowerCase()
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const errText = (err: unknown) => (err instanceof Error ? redact(err.message) : 'unknown error')

export const siteHost = (): string => new URL(config.publicBaseUrl).host
const jobUrl = (jobId: string) => `${config.publicBaseUrl}/jobs/${jobId}`

export const alertsAvailable = () => ({ telegramBot: telegram.botUsername, email: emailEnabled(), site: siteHost() })

// ---------------------------------------------------------------------------
// Signed requests
// ---------------------------------------------------------------------------

const usedNonces = new Map<string, number>()
setInterval(() => {
  const now = Date.now()
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n)
}, 60_000).unref()

async function verify(body: Record<string, unknown>, action: AlertAction): Promise<SignedFields> {
  const f = parseSignedFields(body, Date.now())
  if (usedNonces.has(f.nonce)) throw new AlertError('This signature was already used. Please try again.')
  const ok = await signatureMatches(f, action, siteHost(), config.chainId, (address: Address, message: string, signature: Hex) =>
    publicClient.verifyMessage({ address, message, signature }),
  )
  if (!ok) throw new AlertError('The signature does not match this wallet.')
  usedNonces.set(f.nonce, Date.now() + 2 * 10 * 60_000)
  return f
}

function requireCreator(address: string): void {
  if (!store.jobs().some((j) => key(j.creator) === key(address))) {
    throw new AlertError('Alerts are for job creators. Create a job with this wallet first.')
  }
}

export function alertStatus(address: string): AlertStatus {
  const a = store.alerts()
  const sub = a.email[key(address)]
  return { telegram: Boolean(a.telegram[key(address)]), email: sub ? (sub.confirmed ? 'confirmed' : 'pending') : 'none' }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

const linkCodes = new Map<string, { address: string; expiresAt: number }>()

export async function startTelegramLink(body: Record<string, unknown>): Promise<{ url: string; expiresAt: number }> {
  if (!telegram.botUsername) throw new AlertError('Telegram alerts are not available right now.')
  const f = await verify(body, 'link-telegram')
  requireCreator(f.address)
  const now = Date.now()
  for (const [c, p] of linkCodes) if (p.expiresAt < now || p.address === key(f.address)) linkCodes.delete(c)
  const code = token()
  const expiresAt = now + LINK_CODE_TTL_MS
  linkCodes.set(code, { address: key(f.address), expiresAt })
  return { url: `https://t.me/${telegram.botUsername}?start=${code}`, expiresAt }
}

async function onTelegramMessage(chatId: number, text: string): Promise<string | null> {
  const [rawCommand, arg] = text.trim().split(/\s+/, 2)
  const command = rawCommand.split('@')[0].toLowerCase()
  const a = store.alerts()
  const linked = () => Object.entries(a.telegram).filter(([, l]) => l.chatId === chatId).map(([addr]) => addr)

  if (command === '/start' && arg) {
    const pending = linkCodes.get(arg)
    linkCodes.delete(arg)
    if (!pending || pending.expiresAt < Date.now()) return 'This link has expired. Open your job on ChangeBounty and press "Connect Telegram" again.'
    a.telegram[pending.address] = { chatId, linkedAt: Date.now() }
    store.touch()
    return `Connected. You will get alerts here for jobs created by ${short(pending.address)}.\n\nSend /stop at any time to turn them off.`
  }
  if (command === '/start') return `This bot sends ChangeBounty job alerts. To connect, open your job at ${config.publicBaseUrl}/dashboard, press "Connect Telegram" and follow the link.`
  if (command === '/stop') {
    const wallets = linked()
    for (const w of wallets) delete a.telegram[w]
    store.touch()
    return wallets.length > 0 ? 'Done. Alerts are off for this chat.' : 'No wallets are connected to this chat.'
  }
  if (command === '/status') {
    const wallets = linked()
    return wallets.length > 0 ? `Alerts are on for: ${wallets.map(short).join(', ')}` : 'No wallets are connected to this chat.'
  }
  return `Commands: /status shows connected wallets, /stop turns alerts off.\nManage alerts on your job page: ${config.publicBaseUrl}/dashboard`
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const confirmsPerEmail = new Map<string, number[]>()
let confirmsThisHour: number[] = []

function confirmUrl(sub: EmailSubscription) {
  return `${config.publicBaseUrl}/api/alerts/email/confirm?token=${sub.confirmToken}`
}
function unsubscribeUrl(sub: EmailSubscription) {
  return `${config.publicBaseUrl}/api/alerts/email/unsubscribe?token=${sub.unsubscribeToken}`
}

export async function subscribeEmail(body: Record<string, unknown>): Promise<AlertStatus> {
  if (!emailEnabled()) throw new AlertError('Email alerts are not available right now.')
  const email = String(body.email ?? '')
  if (email !== normaliseEmail(email) || !isValidEmail(email)) throw new AlertError('Enter a valid email address.')
  const f = await verify(body, 'subscribe-email')
  if (f.email !== email) throw new AlertError('Invalid request.')
  requireCreator(f.address)

  const a = store.alerts()
  const k = key(f.address)
  const existing = a.email[k]
  if (existing?.email === email && existing.confirmed) return alertStatus(f.address)
  const now = Date.now()
  if (existing?.email === email && now - existing.lastConfirmSentAt < CONFIRM_RESEND_GAP_MS) {
    throw new AlertError('A confirmation email was just sent. Check your inbox and spam folder.')
  }
  const sentToEmail = (confirmsPerEmail.get(email) ?? []).filter((t) => now - t < 24 * 3600_000)
  confirmsThisHour = confirmsThisHour.filter((t) => now - t < 3600_000)
  if (sentToEmail.length >= MAX_CONFIRMS_PER_EMAIL_PER_DAY || confirmsThisHour.length >= MAX_CONFIRMS_PER_HOUR) {
    throw new AlertError('Too many confirmation emails. Please try again later.')
  }

  const sub: EmailSubscription = { email, confirmed: false, confirmToken: token(), unsubscribeToken: token(), createdAt: now, lastConfirmSentAt: now }
  try {
    await sendEmail({
      to: email,
      subject: 'Confirm your ChangeBounty alerts',
      text: [
        `Someone asked to send ChangeBounty alerts for jobs created by wallet ${f.address} to this address.`,
        '',
        `Confirm: ${confirmUrl(sub)}`,
        '',
        'If this was not you, ignore this email. Nothing is sent unless you confirm.',
      ].join('\n'),
    })
  } catch (err) {
    console.error('[alerts] confirmation email failed:', errText(err))
    throw new AlertError('Could not send the confirmation email. Please try again later.')
  }
  confirmsPerEmail.set(email, [...sentToEmail, now])
  confirmsThisHour.push(now)
  a.email[k] = sub
  store.touch()
  return alertStatus(f.address)
}

const validToken = (t: string) => /^[A-Za-z0-9_-]{20,64}$/.test(t)

function findEmailSub(field: 'confirmToken' | 'unsubscribeToken', t: string): [string, EmailSubscription] | undefined {
  if (!validToken(t)) return undefined
  return Object.entries(store.alerts().email).find(([, s]) => s[field] === t)
}

/** Returns the confirmed address, or null for an unknown or used link. */
export function confirmEmail(t: string): string | null {
  const found = findEmailSub('confirmToken', t)
  if (!found) return null
  const [, sub] = found
  if (!sub.confirmed) {
    sub.confirmed = true
    sub.confirmedAt = Date.now()
    store.touch()
  }
  return sub.email
}

export function unsubscribeEmailByToken(t: string): boolean {
  const found = findEmailSub('unsubscribeToken', t)
  if (!found) return false
  delete store.alerts().email[found[0]]
  store.touch()
  return true
}

export async function unsubscribeSigned(body: Record<string, unknown>): Promise<AlertStatus> {
  const channel = body.channel === 'telegram' || body.channel === 'email' ? body.channel : null
  if (!channel) throw new AlertError('Choose telegram or email.')
  const f = await verify(body, channel === 'telegram' ? 'unsubscribe-telegram' : 'unsubscribe-email')
  const a = store.alerts()
  if (channel === 'telegram') delete a.telegram[key(f.address)]
  else delete a.email[key(f.address)]
  store.touch()
  return alertStatus(f.address)
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

const perJob = new Map<string, number[]>()
const lastFetchAlert = new Map<string, number>()

function underJobLimit(jobId: string): boolean {
  const now = Date.now()
  const recent = (perJob.get(jobId) ?? []).filter((t) => now - t < 3600_000)
  if (recent.length >= MAX_ALERTS_PER_JOB_PER_HOUR) return false
  recent.push(now)
  perJob.set(jobId, recent)
  return true
}

function enqueue(address: string, alert: Alert): void {
  const a = store.alerts()
  const k = key(address)
  const channels: Array<'telegram' | 'email'> = []
  if (a.telegram[k]) channels.push('telegram')
  if (a.email[k]?.confirmed) channels.push('email')
  if (channels.length === 0) return
  const now = Date.now()
  for (const channel of channels) a.outbox.push({ id: token(), address: k, channel, subject: alert.subject, text: alert.text, attempts: 0, nextAt: now, createdAt: now })
  if (a.outbox.length > MAX_OUTBOX) a.outbox.splice(0, a.outbox.length - MAX_OUTBOX)
  store.touch()
  setTimeout(() => void dispatch(), 0)
}

async function deliver(item: { address: string; channel: 'telegram' | 'email'; subject: string; text: string }): Promise<void> {
  const a = store.alerts()
  if (item.channel === 'telegram') {
    const link = a.telegram[item.address]
    if (!link) return
    try {
      await sendTelegram(link.chatId, `${item.subject}\n\n${item.text}`)
    } catch (err) {
      // The person blocked the bot or deleted the chat: stop sending there.
      if (err instanceof TelegramError && (err.code === 403 || (err.code === 400 && /chat not found/i.test(err.message)))) {
        delete a.telegram[item.address]
        store.touch()
        return
      }
      throw err
    }
    return
  }
  const sub = a.email[item.address]
  if (!sub?.confirmed) return
  await sendEmail({
    to: sub.email,
    subject: `ChangeBounty: ${item.subject}`,
    text: `${item.text}\n\n--\nYou get this because you turned on ChangeBounty alerts for wallet ${item.address}.\nUnsubscribe: ${unsubscribeUrl(sub)}`,
    unsubscribeUrl: unsubscribeUrl(sub),
  })
}

let dispatching = false
async function dispatch(): Promise<void> {
  if (dispatching) return
  dispatching = true
  try {
    const a = store.alerts()
    for (const item of [...a.outbox]) {
      const now = Date.now()
      if (item.nextAt > now) continue
      const remove = () => {
        a.outbox = a.outbox.filter((x) => x.id !== item.id)
        store.touch()
      }
      if (now - item.createdAt > OUTBOX_TTL_MS) {
        remove()
        continue
      }
      try {
        await deliver(item)
        remove()
      } catch (err) {
        item.attempts += 1
        if (item.attempts >= MAX_ATTEMPTS) {
          console.error(`[alerts] giving up on a ${item.channel} alert after ${item.attempts} attempts:`, errText(err))
          remove()
          continue
        }
        const retryAfter = err instanceof TelegramError && err.retryAfterSec ? err.retryAfterSec * 1000 : 0
        item.nextAt = now + Math.max(retryAfter, 30_000 * 2 ** (item.attempts - 1))
        store.touch()
      }
    }
  } finally {
    dispatching = false
  }
}

// ---------------------------------------------------------------------------
// Alert sources
// ---------------------------------------------------------------------------

function onJobEvent(job: MonitoredJob, ev: JobEvent): void {
  const discovery = ev.discoveryId ? store.discovery(ev.discoveryId) : undefined
  const txHash = ev.txHash ?? discovery?.txHash
  const alert = jobEventAlert(job, ev, discovery, { jobUrl: jobUrl(job.id), txUrl: ev.type === 'paid' && txHash ? `${config.explorerBase}/tx/${txHash}` : undefined })
  if (!alert) return
  if (ev.type === 'error' && /^Fetch failed:/i.test(ev.message)) {
    const last = lastFetchAlert.get(job.id) ?? 0
    if (Date.now() - last < FETCH_ALERT_GAP_MS) return
    lastFetchAlert.set(job.id, Date.now())
  }
  if (!underJobLimit(job.id)) {
    console.warn(`[alerts] job ${job.id} reached ${MAX_ALERTS_PER_JOB_PER_HOUR} alerts this hour; skipping one.`)
    return
  }
  enqueue(job.creator, alert)
}

/** Called by the chain scan for each VerifierProposed event. Alerts every creator once per event, while the proposal is pending. */
export function onVerifierProposed(proposed: string, activatableAt: bigint, eventKey: string): void {
  const a = store.alerts()
  if (a.seen.includes(eventKey)) return
  a.seen.push(eventKey)
  if (a.seen.length > MAX_SEEN) a.seen.splice(0, a.seen.length - MAX_SEEN)
  store.touch()
  if (Number(activatableAt) * 1000 < Date.now()) return
  const alert = verifierProposedAlert(proposed, Number(activatableAt), `${config.publicBaseUrl}/dashboard`)
  const creators = new Set(store.jobs().filter((j) => j.monitoringReason !== 'the job is cancelled').map((j) => key(j.creator)))
  for (const c of creators) enqueue(c, alert)
}

let started = false
export function startAlerts(): void {
  if (started) return
  started = true
  store.onEvent(onJobEvent)
  startTelegram(onTelegramMessage, {
    get: () => store.alerts().telegramOffset,
    set: (n) => {
      store.alerts().telegramOffset = n
      store.touch()
    },
  })
  setInterval(() => void dispatch(), 5_000).unref()
  if (!config.telegramToken) console.log('[alerts] Telegram alerts off: TELEGRAM_BOT_TOKEN is not set.')
  if (!emailEnabled()) console.log('[alerts] Email alerts off: RESEND_API_KEY and EMAIL_FROM are not both set.')
}

// ---------------------------------------------------------------------------
// Confirmation and unsubscribe pages (plain HTML, no scripts)
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** GET shows a button and only POST acts, so mail scanners that open links cannot confirm or unsubscribe by accident. */
export function alertPage(title: string, message: string, form?: { action: string; label: string }): string {
  const button = form ? `<form method="post" action="${esc(form.action)}"><button type="submit">${esc(form.label)}</button></form>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} - ChangeBounty</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08111f;color:#e3ecf9;font:16px/1.5 system-ui,sans-serif}main{max-width:28rem;padding:2rem}h1{font-size:1.5rem;margin:0 0 .75rem}p{color:#a9b6c9}button{margin-top:1rem;padding:.75rem 1.25rem;border:0;border-radius:.75rem;background:#85b1ed;color:#08111f;font-weight:600;font-size:1rem;cursor:pointer}a{color:#9cc2ff}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${button}<p><a href="${esc(config.publicBaseUrl)}/dashboard">Go to ChangeBounty</a></p></main></body></html>`
}
