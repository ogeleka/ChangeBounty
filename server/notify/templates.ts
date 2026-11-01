import { formatUsdc } from '../../src/onchain-money'
import { config } from '../config'
import { store } from '../store'
import type { JobEvent, JobEventType, MonitoredJob } from '../types'

/**
 * Message content. Page text from a monitored website is NEVER included: it is controlled by whoever
 * runs that site, and echoing it from our address would be a phishing channel. Messages carry only
 * facts we generate ourselves, plus links to the job page and the block explorer.
 */

export const NOTIFY_TYPES: ReadonlySet<JobEventType> = new Set(['change_detected', 'paid', 'rejected', 'paused', 'error'])

export interface Rendered {
  subject: string
  text: string
  html: string
  telegram: string
}

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function jobUrl(job: MonitoredJob): string {
  return `${config.publicBaseUrl}/jobs/${job.id}`
}

function hostOnly(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the monitored page'
  }
}

/** Whether an event should alert subscribers. Internal errors are only sent when a payout is involved. */
export function shouldNotify(event: JobEvent): boolean {
  if (!NOTIFY_TYPES.has(event.type)) return false
  return event.type !== 'error' || Boolean(event.discoveryId)
}

export function render(job: MonitoredJob, event: JobEvent, unsubUrl?: string): Rendered | null {
  if (!shouldNotify(event)) return null
  const host = hostOnly(job.url)
  const link = jobUrl(job)
  let headline: string
  let detail: string
  let tx: string | undefined

  switch (event.type) {
    case 'change_detected':
      headline = `Change detected on ${host}`
      detail = 'The agent saw the page change. The verifier is re-checking it now. You will get another message when it is confirmed or rejected.'
      break
    case 'paid': {
      const d = event.discoveryId ? store.discovery(event.discoveryId) : undefined
      const reward = formatUsdc(BigInt(d?.rewardRaw ?? job.rewardRaw))
      headline = `Payout sent: ${reward} USDC for ${host}`
      detail = `The verifier confirmed the change and the contract paid ${reward} USDC to the agent.`
      tx = event.txHash ?? d?.txHash
      break
    }
    case 'rejected':
      headline = `Change not confirmed on ${host}`
      detail = `${event.message} No payment was made.`
      break
    case 'paused':
      headline = `Monitoring paused for ${host}`
      detail = `${event.message}. Open the job to top up or manage it.`
      break
    default:
      headline = `A payout attempt needs attention on ${host}`
      detail = 'A payout attempt did not complete. The service retries automatically. Open the job for the latest status.'
  }

  const txUrl = tx ? `${config.explorerBase}/tx/${tx}` : undefined
  const subject = `[ChangeBounty #${job.id}] ${headline}`
  const body = [headline, '', detail, '', `Job #${job.id}: ${link}`, ...(txUrl ? [`Transaction: ${txUrl}`] : [])].join('\n')
  const text = unsubUrl ? `${body}\n\nUnsubscribe: ${unsubUrl}` : body
  const telegram = `${body}\n\nSend /stop to unsubscribe.`
  const html = shell(
    `<h1 style="font-size:20px;margin:0 0 12px;color:#0a1628">${esc(headline)}</h1>
     <p style="margin:0 0 16px;line-height:1.55;color:#334155">${esc(detail)}</p>
     <p style="margin:0 0 8px"><a href="${esc(link)}" style="color:#1061a6">Open job #${esc(job.id)}</a></p>
     ${txUrl ? `<p style="margin:0"><a href="${esc(txUrl)}" style="color:#1061a6">View the transaction on Arc Explorer</a></p>` : ''}`,
    unsubUrl ? `<a href="${esc(unsubUrl)}" style="color:#6b7a90;font-size:12px">Unsubscribe from alerts for job #${esc(job.id)}</a>` : '',
  )
  return { subject, text, html, telegram }
}

export function shell(inner: string, footer = ''): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:28px">
<tr><td>
<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7a90;margin-bottom:16px">ChangeBounty</div>
${inner}
${footer ? `<hr style="border:none;border-top:1px solid #e3e8ef;margin:24px 0 12px">${footer}` : ''}
</td></tr></table></td></tr></table></body></html>`
}

export function confirmEmail(job: MonitoredJob, confirmUrl: string, unsubUrl: string): Pick<Rendered, 'subject' | 'text' | 'html'> {
  const host = hostOnly(job.url)
  const subject = `Confirm alerts for ChangeBounty job #${job.id}`
  const text = `Someone (hopefully you) asked for alerts about ${host} (job #${job.id}).\n\nConfirm: ${confirmUrl}\n\nIf this was not you, ignore this email and nothing will be sent.\nUnsubscribe: ${unsubUrl}`
  const html = shell(
    `<h1 style="font-size:20px;margin:0 0 12px;color:#0a1628">Confirm your alerts</h1>
     <p style="margin:0 0 16px;line-height:1.55;color:#334155">Someone (hopefully you) asked for ChangeBounty alerts about <strong>${esc(host)}</strong> (job #${esc(job.id)}).</p>
     <p style="margin:0 0 20px"><a href="${esc(confirmUrl)}" style="background:#0a1628;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">Confirm alerts</a></p>
     <p style="margin:0;color:#6b7a90;font-size:13px">If this was not you, ignore this email and nothing will be sent.</p>`,
    `<a href="${esc(unsubUrl)}" style="color:#6b7a90;font-size:12px">Unsubscribe</a>`,
  )
  return { subject, text, html }
}

/** Small standalone page for confirmation and unsubscribe links opened from an email. */
export function noticePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08111f;color:#f3f6fb;font-family:Arial,Helvetica,sans-serif}
main{max-width:460px;padding:32px;margin:16px;background:#0c1a2e;border:1px solid rgba(160,190,235,.18);border-radius:16px}
h1{font-size:22px;margin:0 0 10px}p{color:#a9b6c9;line-height:1.55;margin:0 0 20px}a{color:#9cc2ff}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="${esc(config.publicBaseUrl)}">Open ChangeBounty</a></main></body></html>`
}
