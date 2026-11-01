import { getAddress, isAddress, isAddressEqual, recoverMessageAddress, type Address, type Hex } from 'viem'
import { alertMessage, type AlertAction } from '../src/lib/alertMessage'
import { formatUsdc } from '../src/onchain-money'
import type { Discovery, JobEvent, MonitoredJob } from './types'

/** Pure helpers for alerts: signed-request checks and message text. No state, no network (tested directly). */

export const SIGNATURE_MAX_AGE_MS = 10 * 60_000
const SNIPPET_LINES = 5
const SNIPPET_CHARS = 200

export class AlertError extends Error {}

export interface Alert {
  subject: string
  text: string
}

export interface SignedFields {
  address: Address
  issuedAt: string
  nonce: string
  signature: Hex
  email?: string
}

/** Shape checks on an untrusted request body. Throws AlertError with a message safe to show. */
export function parseSignedFields(body: Record<string, unknown>, now: number): SignedFields {
  const address = String(body.address ?? '')
  const issuedAt = String(body.issuedAt ?? '')
  const nonce = String(body.nonce ?? '')
  const signature = String(body.signature ?? '')
  if (!isAddress(address)) throw new AlertError('Invalid wallet address.')
  const t = Date.parse(issuedAt)
  if (!Number.isFinite(t) || Math.abs(now - t) > SIGNATURE_MAX_AGE_MS) throw new AlertError('This signature has expired. Please try again.')
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new AlertError('Invalid request.')
  if (!/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) throw new AlertError('Invalid signature.')
  return { address, issuedAt, nonce, signature: signature as Hex, email: body.email === undefined ? undefined : String(body.email) }
}

/**
 * True when `signature` is the wallet's signature over the alert message for `action`. Ordinary wallets are
 * checked locally; `fallback` covers smart-contract wallets (ERC-1271), which need a call to the chain.
 */
export async function signatureMatches(
  f: SignedFields,
  action: AlertAction,
  site: string,
  chainId: number,
  fallback?: (address: Address, message: string, signature: Hex) => Promise<boolean>,
): Promise<boolean> {
  const message = alertMessage({ action, address: f.address, email: f.email, site, chainId, issuedAt: f.issuedAt, nonce: f.nonce })
  try {
    if (isAddressEqual(await recoverMessageAddress({ message, signature: f.signature }), getAddress(f.address))) return true
  } catch {
    /* not an ordinary signature: try the contract-wallet check */
  }
  return fallback ? fallback(f.address, message, f.signature).catch(() => false) : false
}

/** Page text is untrusted: drop control characters and break links so messages only link to ChangeBounty and Arc Explorer. */
export function inertText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\b(https?|ftp):\/\//gi, '$1[:]//')
    .replace(/\b([a-z0-9-]+)\.([a-z]{2,24})\b/gi, '$1[.]$2')
    .trim()
}

function snippet(lines: string[], sign: string): string[] {
  const out = lines.slice(0, SNIPPET_LINES).map((l) => {
    const t = inertText(l)
    return `${sign} ${t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t}`
  })
  if (lines.length > SNIPPET_LINES) out.push(`  …and ${lines.length - SNIPPET_LINES} more`)
  return out
}

export interface AlertLinks {
  jobUrl: string
  txUrl?: string
}

/** The alert for a job event, or null when that event type does not notify. */
export function jobEventAlert(job: MonitoredJob, ev: JobEvent, discovery: Discovery | undefined, links: AlertLinks): Alert | null {
  const page = inertText(job.url)
  if (ev.type === 'paid') {
    const lines = [`A change on the page you are watching was confirmed by the verifier and paid.`, '', `Job #${job.id}: ${page}`]
    if (discovery && (discovery.added.length > 0 || discovery.removed.length > 0)) {
      if (discovery.added.length > 0) lines.push('', 'New text:', ...snippet(discovery.added, '+'))
      if (discovery.removed.length > 0) lines.push('', 'Removed text:', ...snippet(discovery.removed, '-'))
    }
    lines.push('')
    if (discovery?.rewardRaw) lines.push(`Reward paid to the agent: ${formatUsdc(BigInt(discovery.rewardRaw))} USDC`)
    if (links.txUrl) lines.push(`Payment: ${links.txUrl}`)
    lines.push(`Job page: ${links.jobUrl}`)
    return { subject: `Job #${job.id}: change confirmed and paid`, text: lines.join('\n') }
  }
  if (ev.type === 'paused') {
    const reason = ev.message.replace(/^Monitoring paused:\s*/i, '')
    const fix = /funding/i.test(reason) ? 'Add USDC on the job page to resume monitoring.' : 'Open the job page for details.'
    return {
      subject: `Job #${job.id} is paused`,
      text: [`Monitoring of this page is paused: ${reason}.`, '', `Job #${job.id}: ${page}`, '', fix, `Job page: ${links.jobUrl}`].join('\n'),
    }
  }
  if (ev.type === 'error' && /^URL rejected:/i.test(ev.message)) {
    return {
      subject: `Job #${job.id} cannot be monitored`,
      text: [`ChangeBounty will not monitor this page. ${ev.message}`, '', `Job #${job.id}: ${page}`, '', 'You can cancel the job and withdraw your USDC on the job page.', `Job page: ${links.jobUrl}`].join('\n'),
    }
  }
  if (ev.type === 'error' && /^Fetch failed:/i.test(ev.message)) {
    return {
      subject: `Job #${job.id}: the page could not be reached`,
      text: [`ChangeBounty could not load the page you are watching. ${ev.message}`, '', `Job #${job.id}: ${page}`, '', 'Monitoring continues and retries automatically. Nothing is paid while the page is unreachable.', `Job page: ${links.jobUrl}`].join('\n'),
    }
  }
  return null
}

export function verifierProposedAlert(proposed: string, activatableAt: number, dashboardUrl: string): Alert {
  const when = new Date(activatableAt * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  return {
    subject: 'Security notice: a new verifier was proposed',
    text: [
      'The ChangeBounty contract owner proposed a new verifier, the service that approves payouts.',
      '',
      `Proposed verifier: ${proposed}`,
      `It can take over from: ${when}`,
      '',
      'Payouts still go only to the agent each job was created with. If you do not trust the new verifier, cancel your jobs and withdraw your USDC before that time.',
      `Your jobs: ${dashboardUrl}`,
    ].join('\n'),
  }
}
