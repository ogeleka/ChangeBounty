import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { isAddress, isHex, type Hex } from 'viem'
import {
  AlertError,
  alertPage,
  alertsAvailable,
  alertStatus,
  confirmEmail,
  startAlerts,
  startTelegramLink,
  subscribeEmail,
  unsubscribeEmailByToken,
  unsubscribeSigned,
} from './alerts'
import { readJob, revertMessage, verifierHasGas } from './chain'
import { recoverInterrupted } from './verifier'
import { syncFromChain, syncStatus } from './chainSync'
import { config } from './config'
import { publishAnnouncement, renderAnnouncementsPage, tokenMatches } from './demoSite'
import { checkJob, registerFromTx, startMonitor } from './monitor'
import { redact } from './redact'
import { checkUrlSyntax, UnsafeUrlError, validatePublicUrl } from './ssrf'
import { store } from './store'
import type { JobView, MonitoredJob, PublicConfig } from './types'

const DIST = join(process.cwd(), 'dist')
const MAX_BODY = 8 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isString = typeof body === 'string'
  res.writeHead(status, {
    'content-type': isString ? 'text/html; charset=utf-8' : 'application/json',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(isString ? body : JSON.stringify(body))
}

/** Reads and discards a small body (HTML form posts), so keep-alive connections stay usable. */
async function drain(req: IncomingMessage): Promise<void> {
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.')
  }
}

/** Alert endpoints report bad input as 400 with a message safe to show. */
async function alertCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AlertError) throw new HttpError(400, err.message)
    throw err
  }
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'Body must be a JSON object.')
  }
}

/** Fixed-window limiter keyed by client address and bucket. In-memory: adequate for a single instance. */
const hits = new Map<string, number[]>()
function limit(req: IncomingMessage, bucket: string, max: number, windowMs: number): void {
  const forwarded = process.env.TRUST_PROXY === '1' || process.env.SPACE_ID ? (String(req.headers['x-forwarded-for'] ?? '').split(',').pop() ?? '').trim() : ''
  const key = `${bucket}:${forwarded || req.socket.remoteAddress || 'unknown'}`
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= max) throw new HttpError(429, 'Too many requests. Please slow down.')
  recent.push(now)
  hits.set(key, recent)
}
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of hits) if (v.every((t) => now - t > 120_000)) hits.delete(k)
}, 60_000).unref()

const chainCache = new Map<string, { at: number; value: JobView['chain'] }>()
async function chainView(job: MonitoredJob): Promise<JobView['chain']> {
  const cached = chainCache.get(job.id)
  if (cached && Date.now() - cached.at < 4000) return cached.value
  try {
    const c = await readJob(BigInt(job.id))
    const value = { status: c.status, balanceRaw: c.balance.toString(), payouts: c.payouts }
    chainCache.set(job.id, { at: Date.now(), value })
    return value
  } catch {
    return cached?.value
  }
}

async function jobView(job: MonitoredJob): Promise<JobView> {
  // Strip the large baseline text from API responses; the hash is enough for the UI.
  const baseline = job.baseline ? { ...job.baseline, text: '' } : undefined
  return { ...job, baseline, chain: await chainView(job), discoveries: store.discoveriesFor(job.id) }
}

function publicConfig(): PublicConfig {
  return {
    network: config.network,
    chainId: config.chainId,
    chainName: config.chainName,
    explorerBase: config.explorerBase,
    usdc: config.usdc,
    contract: config.contract,
    agentAddress: config.agentAddress,
    verifierAddress: config.verifierAddress,
    demoUrl: `${config.publicBaseUrl}/api/demo-site/announcements`,
    pollIntervalSec: Math.round(config.pollIntervalMs / 1000),
    demoPublishEnabled: config.adminToken !== null,
    verifierReady: config.verifierKey !== null && config.contract !== null,
    minRewardRaw: config.minRewardRaw.toString(),
    alerts: alertsAvailable(),
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!existsSync(DIST)) return false
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, safe)
  if (!file.startsWith(DIST)) return false
  const exists = existsSync(file) && statSync(file).isFile()
  if (!exists) {
    // SPA fallback for client-side routes (not for missing assets).
    if (extname(safe)) return false
    file = join(DIST, 'index.html')
    if (!existsSync(file)) return false
  }
  const ext = extname(file)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
  return true
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === '/api/health') {
    return send(res, 200, {
      ok: true,
      network: config.network,
      contractConfigured: config.contract !== null,
      verifierConfigured: config.verifierKey !== null,
      verifierHasGas: gasOk,
      sync: syncStatus,
      jobs: store.jobs().length,
    })
  }
  if (path === '/api/config' && method === 'GET') return send(res, 200, publicConfig())

  if (path === '/api/demo-site/announcements' && method === 'GET') {
    return send(res, 200, renderAnnouncementsPage(), {
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'cache-control': 'no-cache',
    })
  }
  if (path === '/api/demo/announcements' && method === 'GET') return send(res, 200, store.announcements())

  if (path === '/api/demo/publish' && method === 'POST') {
    limit(req, 'publish', 10, 60_000)
    if (!config.adminToken) throw new HttpError(503, 'Publishing is disabled: DEMO_ADMIN_TOKEN is not configured.')
    if (!tokenMatches(req.headers.authorization)) throw new HttpError(401, 'Invalid or missing admin token.')
    const body = await readJson(req)
    try {
      return send(res, 201, publishAnnouncement(body.title, body.body))
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Invalid announcement.')
    }
  }

  if (path === '/api/validate-url' && method === 'POST') {
    limit(req, 'validate', 30, 60_000)
    const body = await readJson(req)
    try {
      checkUrlSyntax(String(body.url ?? ''))
      const parsed = await validatePublicUrl(String(body.url ?? ''))
      return send(res, 200, { ok: true, url: parsed.toString() })
    } catch (err) {
      if (err instanceof UnsafeUrlError) return send(res, 200, { ok: false, reason: err.message })
      throw err
    }
  }

  if (path === '/api/jobs' && method === 'GET') {
    const jobs = [...store.jobs()].sort((a, b) => b.registeredAt - a.registeredAt)
    return send(res, 200, await Promise.all(jobs.map(jobView)))
  }

  if (path === '/api/jobs/register' && method === 'POST') {
    limit(req, 'register', 12, 60_000)
    const body = await readJson(req)
    const txHash = String(body.txHash ?? '')
    if (!isHex(txHash) || txHash.length !== 66) throw new HttpError(400, 'txHash must be a 32-byte hex string.')
    try {
      const jobs = await registerFromTx(txHash as Hex)
      return send(res, 200, await Promise.all(jobs.map(jobView)))
    } catch (err) {
      throw new HttpError(422, err instanceof Error ? redact(revertMessage(err)) : 'Could not register that transaction.')
    }
  }

  const jobMatch = /^\/api\/jobs\/(\d{1,18})(\/check)?$/.exec(path)
  if (jobMatch) {
    const job = store.job(jobMatch[1])
    if (!job) throw new HttpError(404, 'Job not found. It may not have been registered with the monitor yet.')
    if (jobMatch[2]) {
      if (method !== 'POST') throw new HttpError(405, 'Use POST.')
      limit(req, `check-${job.id}`, 6, 60_000)
      await checkJob(job, 'manual')
      return send(res, 200, await jobView(job))
    }
    if (method === 'GET') return send(res, 200, await jobView(job))
  }

  if (path === '/api/payments' && method === 'GET') {
    const paid = store
      .allDiscoveries()
      .filter((d) => d.status === 'paid' && d.txHash)
      .sort((a, b) => (b.paidAt ?? 0) - (a.paidAt ?? 0))
      .slice(0, 100)
    return send(res, 200, paid)
  }

  if (path === '/api/alerts/status' && method === 'GET') {
    limit(req, 'alerts-status', 60, 60_000)
    const address = url.searchParams.get('address') ?? ''
    if (!isAddress(address)) throw new HttpError(400, 'Invalid wallet address.')
    return send(res, 200, alertStatus(address))
  }
  if (path === '/api/alerts/telegram' && method === 'POST') {
    limit(req, 'alerts-telegram', 10, 60_000)
    const body = await readJson(req)
    return send(res, 200, await alertCall(() => startTelegramLink(body)))
  }
  if (path === '/api/alerts/email' && method === 'POST') {
    limit(req, 'alerts-email', 5, 60_000)
    const body = await readJson(req)
    return send(res, 200, await alertCall(() => subscribeEmail(body)))
  }
  if (path === '/api/alerts/unsubscribe' && method === 'POST') {
    limit(req, 'alerts-unsubscribe', 10, 60_000)
    const body = await readJson(req)
    return send(res, 200, await alertCall(() => unsubscribeSigned(body)))
  }
  if (path === '/api/alerts/email/confirm' || path === '/api/alerts/email/unsubscribe') {
    limit(req, 'alerts-link', 30, 60_000)
    const t = url.searchParams.get('token') ?? ''
    const confirm = path.endsWith('/confirm')
    const action = `${path}?token=${encodeURIComponent(t)}`
    if (method === 'GET') {
      const page = confirm
        ? alertPage('Confirm email alerts', 'Press the button to start receiving ChangeBounty alerts at this address.', { action, label: 'Confirm alerts' })
        : alertPage('Unsubscribe', 'Press the button to stop ChangeBounty alerts to this address.', { action, label: 'Unsubscribe' })
      return send(res, 200, page, { 'content-security-policy': PAGE_CSP })
    }
    if (method === 'POST') {
      await drain(req)
      if (confirm) {
        const email = confirmEmail(t)
        const page = email ? alertPage('Alerts confirmed', `ChangeBounty alerts will be sent to ${email}. Every email has an unsubscribe link.`) : alertPage('Link not valid', 'This confirmation link is unknown or was replaced by a newer one. Subscribe again from your job page.')
        return send(res, email ? 200 : 404, page, { 'content-security-policy': PAGE_CSP })
      }
      const done = unsubscribeEmailByToken(t)
      const page = done ? alertPage('Unsubscribed', 'You will not get any more ChangeBounty alerts at this address.') : alertPage('Already unsubscribed', 'This address is not subscribed to ChangeBounty alerts.')
      return send(res, 200, page, { 'content-security-policy': PAGE_CSP })
    }
    throw new HttpError(405, 'Use GET or POST.')
  }

  if (path.startsWith('/api/')) throw new HttpError(404, 'Not found.')
  if ((method === 'GET' || method === 'HEAD') && serveStatic(req, res, path)) return
  throw new HttpError(404, 'Not found.')
}

// A bad request or a flaky upstream must never take the whole service down.
process.on('uncaughtException', (err) => console.error('[server] uncaught:', err.message))
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason instanceof Error ? reason.message : reason))

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    if (res.headersSent) return res.end()
    if (err instanceof HttpError) return send(res, err.status, { error: err.message })
    console.error('[server]', err instanceof Error ? err.message : err)
    send(res, 500, { error: 'Internal error.' })
  })
})

server.on('error', (err) => {
  console.error('[server] cannot start:', err.message)
  process.exit(1)
})

let gasOk = false
const refreshGas = () => void verifierHasGas().then((ok) => (gasOk = ok), () => (gasOk = false))
setInterval(refreshGas, 60_000).unref()

server.listen(config.port, () => {
  console.log(`[server] ChangeBounty API on :${config.port} (${config.chainName}, contract ${config.contract ?? 'not set'})`)
  if (config.allowPrivateHosts.size > 0) console.warn('[server] ALLOW_PRIVATE_FETCH_HOSTS is set. Development only.')
  if (!config.verifierKey) console.warn('[server] VERIFIER_PRIVATE_KEY is not set: payouts are disabled.')
  refreshGas()
  // Before the first sync, so payments recovered at startup also send alerts.
  startAlerts()
  // Reconcile with the chain, settle anything a restart interrupted, then begin polling.
  void (async () => {
    await syncFromChain()
    await recoverInterrupted().catch((err: unknown) => console.error('[recover]', revertMessage(err)))
    startMonitor(syncFromChain)
  })()
})
