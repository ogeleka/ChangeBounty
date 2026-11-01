import { config } from './config'
import { redact } from './redact'

/** Plain-text email through the Resend HTTP API (https://resend.com). Enabled when RESEND_API_KEY and EMAIL_FROM are set. */

export const emailEnabled = (): boolean => Boolean(config.resendKey && config.emailFrom)

export async function sendEmail(m: { to: string; subject: string; text: string; unsubscribeUrl?: string }): Promise<void> {
  if (!emailEnabled()) throw new Error('Email is not configured.')
  const headers = m.unsubscribeUrl ? { 'List-Unsubscribe': `<${m.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: [m.to], subject: m.subject.replace(/[\r\n]+/g, ' '), text: m.text, headers }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('Could not reach the email provider.')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(`The email provider refused the message (${res.status}${body.message ? `: ${redact(body.message)}` : ''}).`)
  }
}
