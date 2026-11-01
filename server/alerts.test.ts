import { describe, expect, test } from 'bun:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { alertMessage, isValidEmail, normaliseEmail, type AlertRequest } from '../src/lib/alertMessage'
import { AlertError, inertText, jobEventAlert, parseSignedFields, signatureMatches, verifierProposedAlert } from './alertText'
import type { Discovery, JobEvent, MonitoredJob } from './types'

const account = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())
const SITE = 'changebounty.example'
const CHAIN = 5042

async function signedBody(overrides: Partial<AlertRequest> = {}, signer = account) {
  const req: AlertRequest = { action: 'subscribe-email', address: account.address, email: 'me@example.com', site: SITE, chainId: CHAIN, issuedAt: new Date().toISOString(), nonce: 'a'.repeat(32), ...overrides }
  const signature = await signer.signMessage({ message: alertMessage(req) })
  return { req, body: { address: req.address, email: req.email, issuedAt: req.issuedAt, nonce: req.nonce, signature } as Record<string, unknown> }
}

describe('alert signatures', () => {
  test('a signature from the wallet over the same request is accepted', async () => {
    const { body } = await signedBody()
    expect(await signatureMatches(parseSignedFields(body, Date.now()), 'subscribe-email', SITE, CHAIN)).toBe(true)
  })

  test('another wallet, action, email, site or chain is rejected', async () => {
    const now = Date.now()
    const { body } = await signedBody({}, other)
    expect(await signatureMatches(parseSignedFields(body, now), 'subscribe-email', SITE, CHAIN)).toBe(false)

    const good = (await signedBody()).body
    const f = parseSignedFields(good, now)
    expect(await signatureMatches(f, 'unsubscribe-email', SITE, CHAIN)).toBe(false)
    expect(await signatureMatches({ ...f, email: 'attacker@example.com' }, 'subscribe-email', SITE, CHAIN)).toBe(false)
    expect(await signatureMatches(f, 'subscribe-email', 'evil.example', CHAIN)).toBe(false)
    expect(await signatureMatches(f, 'subscribe-email', SITE, 5042002)).toBe(false)
  })

  test('the contract-wallet fallback is only used when local recovery fails', async () => {
    const { body } = await signedBody({}, other)
    const f = parseSignedFields(body, Date.now())
    expect(await signatureMatches(f, 'subscribe-email', SITE, CHAIN, async () => true)).toBe(true)
    expect(await signatureMatches(f, 'subscribe-email', SITE, CHAIN, async () => Promise.reject(new Error('rpc down')))).toBe(false)
  })

  test('malformed or expired requests are refused before any signature check', async () => {
    const { body } = await signedBody()
    const now = Date.now()
    expect(() => parseSignedFields({ ...body, address: '0x123' }, now)).toThrow(AlertError)
    expect(() => parseSignedFields({ ...body, nonce: 'short' }, now)).toThrow(AlertError)
    expect(() => parseSignedFields({ ...body, signature: '0xabc' }, now)).toThrow(AlertError)
    expect(() => parseSignedFields(body, now + 11 * 60_000)).toThrow('expired')
    expect(() => parseSignedFields({ ...body, issuedAt: 'yesterday' }, now)).toThrow(AlertError)
  })

  test('the message names the action, wallet, site and chain, and shows the email only when given', () => {
    const base: AlertRequest = { action: 'link-telegram', address: account.address, site: SITE, chainId: CHAIN, issuedAt: '2026-11-02T10:00:00.000Z', nonce: 'b'.repeat(32) }
    const text = alertMessage(base)
    expect(text).toContain('Telegram')
    expect(text).toContain(account.address)
    expect(text).toContain(`Site: ${SITE}`)
    expect(text).toContain(`Chain ID: ${CHAIN}`)
    expect(text).not.toContain('Email:')
    expect(alertMessage({ ...base, action: 'subscribe-email', email: 'x@y.co' })).toContain('Email: x@y.co')
  })
})

describe('email addresses', () => {
  test('normalised and validated', () => {
    expect(normaliseEmail('  Me@Example.COM ')).toBe('me@example.com')
    for (const ok of ['a@b.co', 'first.last+tag@sub.example.org']) expect(isValidEmail(ok)).toBe(true)
    for (const bad of ['', 'a@b', 'a@@b.co', 'a b@c.co', 'a@b.co\nBcc: x@y.co', `${'a'.repeat(250)}@b.co`]) expect(isValidEmail(bad)).toBe(false)
  })
})

describe('alert text', () => {
  const job: MonitoredJob = {
    id: '7',
    creator: account.address,
    agent: other.address,
    url: 'https://news.example.com/updates',
    urlHash: '0x',
    rewardRaw: '10000',
    createTxHash: '0x',
    registeredAt: 0,
    monitoring: 'active',
    checks: 3,
    events: [],
  }
  const ev = (type: JobEvent['type'], message: string): JobEvent => ({ t: 0, type, message })
  const links = { jobUrl: 'https://cb.example/jobs/7', txUrl: 'https://explorer.example/tx/0xabc' }

  test('page text cannot carry live links or control characters', () => {
    const s = inertText('Visit https://evil.example/login or evil.co now‮\u0007')
    expect(s).not.toMatch(/https?:\/\//)
    expect(s).not.toContain('evil.example')
    expect(s).not.toContain('evil.co ')
    expect(s).not.toMatch(/[\u0000-\u001f‮]/)
  })

  test('a paid change includes what changed, the reward and both links', () => {
    const d: Discovery = { id: '0x1', jobId: '7', baselineHash: '', newHash: '', detectedAt: 0, added: ['New tender: bridge repair', 'see https://phish.example'], removed: ['Old line'], status: 'paid', rewardRaw: '10000' }
    const a = jobEventAlert(job, ev('paid', 'USDC reward paid'), d, links)!
    expect(a.subject).toBe('Job #7: change confirmed and paid')
    expect(a.text).toContain('+ New tender: bridge repair')
    expect(a.text).toContain('- Old line')
    expect(a.text).toContain('0.01 USDC')
    expect(a.text).toContain(links.txUrl)
    expect(a.text).toContain(links.jobUrl)
    expect(a.text).not.toContain('https://phish.example')
  })

  test('a paused job explains how to resume', () => {
    const a = jobEventAlert(job, ev('paused', 'Monitoring paused: the job needs more USDC funding'), undefined, links)!
    expect(a.subject).toBe('Job #7 is paused')
    expect(a.text).toContain('Add USDC')
  })

  test('unreachable and refused pages alert; routine events do not', () => {
    expect(jobEventAlert(job, ev('error', 'Fetch failed: timed out'), undefined, links)?.subject).toContain('could not be reached')
    expect(jobEventAlert(job, ev('error', 'URL rejected: private address'), undefined, links)?.subject).toContain('cannot be monitored')
    for (const t of ['registered', 'baseline', 'check', 'change_detected', 'verifying', 'verified', 'minor_change', 'rejected'] as const) {
      expect(jobEventAlert(job, ev(t, 'x'), undefined, links)).toBeNull()
    }
    expect(jobEventAlert(job, ev('error', 'Check failed: rpc'), undefined, links)).toBeNull()
  })

  test('a verifier proposal names the new verifier and when it can act', () => {
    const a = verifierProposedAlert(other.address, 1_800_000_000, 'https://cb.example/dashboard')
    expect(a.text).toContain(other.address)
    expect(a.text).toContain('2027-01-15 08:00:00 UTC')
    expect(a.text).toContain('withdraw')
  })
})
