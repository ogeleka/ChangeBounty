import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Use a throwaway data directory so tests never touch real monitoring state.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cb-notify-'))

const { store } = await import('./store')
const svc = await import('./notify/service')
const { DeliveryError, emailTransport, buildTelegram } = await import('./notify/transports')
const { render, shouldNotify } = await import('./notify/templates')
import type { EmailMessage, Transport } from './notify/transports'
import type { MonitoredJob } from './types'

const sentEmails: EmailMessage[] = []
const sentTelegram: Array<{ chat: string; text: string }> = []
let telegramFailure: DeliveryError | null = null

const fake: Transport = {
  email: {
    send: (msg) => {
      sentEmails.push(msg)
      return Promise.resolve()
    },
  },
  telegram: {
    botUsername: 'ChangeBountyTestBot',
    send: (chat, text) => {
      if (telegramFailure) return Promise.reject(telegramFailure)
      sentTelegram.push({ chat, text })
      return Promise.resolve()
    },
    getUpdates: () => Promise.resolve([]),
  },
}

const HASH = `0x${'ab'.repeat(32)}`
const job: MonitoredJob = {
  id: '77',
  creator: '0x0000000000000000000000000000000000000001',
  agent: '0x0000000000000000000000000000000000000002',
  url: 'https://news.example.com/updates',
  urlHash: HASH,
  rewardRaw: '10000',
  createTxHash: HASH,
  registeredAt: Date.now(),
  monitoring: 'active',
  checks: 0,
  events: [],
}

const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1]
const tgUpdate = (text: string, chat = 555) => ({ update_id: 1, message: { text, chat: { id: chat, type: 'private' } } })

beforeAll(() => {
  svc.setTransport(fake)
  svc.setPacing(0)
  store.putJob(job)
  store.onEvent(svc.dispatchEvent)
})

describe('email address handling', () => {
  test('accepts normal addresses and lowercases them', () => {
    expect(svc.normaliseEmail('  Alice@Example.COM ')).toBe('alice@example.com')
    expect(svc.normaliseEmail('first.last+tag@sub.example.org')).toBe('first.last+tag@sub.example.org')
  })
  for (const bad of ['', 'plain', 'a@b', 'a@b.c', 'a..b@example.com', 'a b@example.com', 'a@example.com\r\nBcc: victim@example.com', 'a@exa mple.com', '<x>@example.com', 42, null]) {
    test(`rejects ${JSON.stringify(bad)}`, () => expect(svc.normaliseEmail(bad)).toBeNull())
  }
})

describe('email alerts need confirmation', () => {
  test('double opt-in, delivery, dedupe and unsubscribe', async () => {
    await svc.requestEmailSubscription('77', 'Fan@Example.com')
    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0].to).toBe('fan@example.com')
    expect(sentEmails[0].subject).toContain('Confirm')
    const confirmToken = tokenFrom(sentEmails[0].text)

    // Not confirmed yet: events must not reach this address.
    store.addEvent(job, 'change_detected', 'Meaningful change detected', { discoveryId: 'd1' })
    await svc.drain()
    expect(sentEmails).toHaveLength(1)

    // Asking again right away stays quiet and sends nothing new.
    await svc.requestEmailSubscription('77', 'fan@example.com')
    expect(sentEmails).toHaveLength(1)

    expect(svc.confirmSubscription('not-a-real-token')).toBeNull()
    expect(svc.confirmSubscription(confirmToken)?.status).toBe('active')

    store.addEvent(job, 'paid', 'USDC reward paid to the agent onchain.', { discoveryId: 'd2', txHash: HASH })
    await svc.drain()
    expect(sentEmails).toHaveLength(2)
    const paid = sentEmails[1]
    expect(paid.subject).toContain('Payout sent')
    expect(paid.text).toContain(`/tx/${HASH}`)
    expect(paid.text).toContain('Unsubscribe:')
    expect(paid.unsubscribeUrl).toContain('/api/notify/unsubscribe?token=')

    // The same event can never be delivered twice.
    expect(store.markSent(`${store.subscriptions()[0].id}:paid:d2`)).toBe(false)

    expect(svc.unsubscribe(tokenFrom(paid.text))).not.toBeNull()
    store.addEvent(job, 'paid', 'USDC reward paid to the agent onchain.', { discoveryId: 'd3', txHash: HASH })
    await svc.drain()
    expect(sentEmails).toHaveLength(2)
  })

  test('invalid address and unknown job are refused', async () => {
    await expect(svc.requestEmailSubscription('77', 'nope')).rejects.toThrow('valid email')
    await expect(svc.requestEmailSubscription('999999', 'a@example.com')).rejects.toThrow('Job not found')
  })
})

describe('message content', () => {
  test('page text is never included and internal errors are filtered', () => {
    expect(shouldNotify({ t: 1, type: 'error', message: 'x' })).toBe(false)
    expect(shouldNotify({ t: 1, type: 'error', message: 'x', discoveryId: 'd' })).toBe(true)
    expect(shouldNotify({ t: 1, type: 'check', message: 'x' })).toBe(false)
    const r = render(job, { t: 1, type: 'change_detected', message: 'Meaningful change detected: 1 new lines', discoveryId: 'd9' })!
    expect(r.subject).toContain('news.example.com')
    expect(r.text).not.toContain('Meaningful change detected: 1 new')
    expect(r.html).not.toContain('<script')
  })
  test('html output is escaped', () => {
    const r = render({ ...job, id: '1<b>' }, { t: 1, type: 'rejected', message: 'Verifier said <script>alert(1)</script>', discoveryId: 'd' })!
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;')
  })
})

describe('telegram alerts', () => {
  test('deep link binds a chat once, delivers, and /stop removes it', async () => {
    const url = svc.createTelegramLink('77')
    expect(url.startsWith('https://t.me/ChangeBountyTestBot?start=')).toBe(true)
    const token = url.split('start=')[1]

    await svc.handleTelegramUpdate(tgUpdate(`/start ${token}`))
    expect(sentTelegram.at(-1)?.text).toContain('Subscribed')
    expect(store.subscriptions().filter((s) => s.channel === 'telegram' && s.target === '555')).toHaveLength(1)

    // The link is single use.
    await svc.handleTelegramUpdate(tgUpdate(`/start ${token}`, 777))
    expect(sentTelegram.at(-1)?.text).toContain('expired')
    expect(store.subscriptions().some((s) => s.target === '777')).toBe(false)

    store.addEvent(job, 'rejected', 'Verifier rejected the discovery: the page changed again.', { discoveryId: 'd10' })
    await svc.drain()
    const alert = sentTelegram.at(-1)!
    expect(alert.chat).toBe('555')
    expect(alert.text).toContain('Change not confirmed')
    expect(alert.text).toContain('/stop')

    await svc.handleTelegramUpdate(tgUpdate('/status'))
    expect(sentTelegram.at(-1)?.text).toContain('job #77')
    await svc.handleTelegramUpdate(tgUpdate('/stop'))
    expect(store.subscriptions().some((s) => s.target === '555')).toBe(false)
  })

  test('group chats are ignored and a blocked bot removes the subscription', async () => {
    const before = sentTelegram.length
    await svc.handleTelegramUpdate({ update_id: 2, message: { text: '/start abc', chat: { id: 9, type: 'group' } } })
    expect(sentTelegram).toHaveLength(before)

    const token = svc.createTelegramLink('77').split('start=')[1]
    await svc.handleTelegramUpdate(tgUpdate(`/start ${token}`, 888))
    expect(store.subscriptions().some((s) => s.target === '888')).toBe(true)

    telegramFailure = new DeliveryError('Telegram rejected the request (403).', true)
    store.addEvent(job, 'paused', 'Monitoring paused: the job needs more USDC funding')
    await svc.drain()
    telegramFailure = null
    expect(store.subscriptions().some((s) => s.target === '888')).toBe(false)
  })
})

describe('transports', () => {
  // Built at runtime so the repository secret scan never sees a token-shaped literal.
  const SECRET_TOKEN = `${'123456789'}:${'Ab'.repeat(18)}`
  const RESEND_FAKE = ['re', 'testkey123', 'abcdefghijklmnop'].join('_')

  test('Telegram errors never contain the bot token', async () => {
    const leaky = (() => Promise.reject(new Error(`connect failed https://api.telegram.org/bot${SECRET_TOKEN}/getMe`))) as unknown as typeof fetch
    const err = await buildTelegram(SECRET_TOKEN, leaky).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(SECRET_TOKEN)

    const rejected = (() => Promise.resolve(new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 }))) as unknown as typeof fetch
    const err2 = await buildTelegram(SECRET_TOKEN, rejected).catch((e: Error) => e)
    expect((err2 as Error).message).not.toContain(SECRET_TOKEN)
  })

  test('Resend request carries the key only in the Authorization header and sets one-click unsubscribe', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fakeFetch = ((url: string, init: RequestInit) => {
      seen = { url, init }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const t = emailTransport(RESEND_FAKE, 'ChangeBounty <alerts@example.com>', fakeFetch)
    await t.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>h</p>', unsubscribeUrl: 'https://x.example/u?token=abc' })
    expect(seen?.url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(String(seen?.init.body)) as { headers: Record<string, string>; to: string[] }
    expect(body.to).toEqual(['a@example.com'])
    expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(String(seen?.init.body)).not.toContain(RESEND_FAKE)
  })

  test('Resend client errors are permanent, rate limits are retried', async () => {
    const mk = (status: number) => emailTransport(RESEND_FAKE, 'a@example.com', (() => Promise.resolve(new Response('{}', { status }))) as unknown as typeof fetch)
    const e422 = await mk(422).send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' }).catch((e: InstanceType<typeof DeliveryError>) => e)
    const e429 = await mk(429).send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' }).catch((e: InstanceType<typeof DeliveryError>) => e)
    expect((e422 as InstanceType<typeof DeliveryError>).permanent).toBe(true)
    expect((e429 as InstanceType<typeof DeliveryError>).permanent).toBe(false)
  })
})
