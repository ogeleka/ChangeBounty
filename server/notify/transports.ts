import { config } from '../config'

/**
 * Delivery transports for Resend (email) and Telegram. Both talk to fixed official API hosts.
 * Errors are reduced to short, safe messages: the Telegram token is part of the request URL and must
 * never reach a log, an event or a response.
 */

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** True when the recipient can never be reached again (blocked the bot, chat gone). */
    readonly permanent = false,
  ) {
    super(message)
    this.name = 'DeliveryError'
  }
}

export interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
  /** Absolute https URL for RFC 8058 one-click unsubscribe. */
  unsubscribeUrl?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: { text?: string; chat: { id: number; type: string } }
}

export interface Transport {
  email?: { send(msg: EmailMessage): Promise<void> }
  telegram?: {
    botUsername: string
    send(chatId: string, text: string): Promise<void>
    getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>
  }
}

type FetchLike = typeof fetch

const RESEND_URL = 'https://api.resend.com/emails'
const TELEGRAM_ROOT = 'https://api.telegram.org'

function emailTransport(key: string, from: string, fetchImpl: FetchLike): NonNullable<Transport['email']> {
  return {
    async send(msg) {
      let res: Response
      try {
        res = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [msg.to],
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
            ...(msg.unsubscribeUrl
              ? { headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }
              : {}),
          }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch {
        throw new DeliveryError('Email provider unreachable.')
      }
      if (res.ok) return
      // 4xx other than rate limiting will not succeed on retry.
      throw new DeliveryError(`Email provider rejected the message (HTTP ${res.status}).`, res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408)
    },
  }
}

async function telegramCall<T>(token: string, method: string, body: unknown, fetchImpl: FetchLike, timeoutMs: number): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${TELEGRAM_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new DeliveryError('Telegram unreachable.')
  }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string }
  if (res.ok && data.ok) return data.result as T
  const code = data.error_code ?? res.status
  const gone = code === 403 || (code === 400 && /chat not found/i.test(data.description ?? ''))
  throw new DeliveryError(`Telegram rejected the request (${code}).`, gone)
}

export async function buildTelegram(token: string, fetchImpl: FetchLike): Promise<NonNullable<Transport['telegram']>> {
  const me = await telegramCall<{ username: string }>(token, 'getMe', {}, fetchImpl, 10_000)
  // Updates are collected by polling, so any webhook set earlier for this bot must be cleared.
  await telegramCall(token, 'deleteWebhook', { drop_pending_updates: false }, fetchImpl, 10_000)
  return {
    botUsername: me.username,
    async send(chatId, text) {
      await telegramCall(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 3500), disable_web_page_preview: true }, fetchImpl, 15_000)
    },
    getUpdates: (offset, timeoutSec) =>
      telegramCall<TelegramUpdate[]>(token, 'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, fetchImpl, (timeoutSec + 10) * 1000),
  }
}

/** Builds the real transports from configuration. Missing credentials simply leave a channel out. */
export async function buildTransport(fetchImpl: FetchLike = fetch): Promise<Transport> {
  const out: Transport = {}
  if (config.resendKey && config.emailFrom) out.email = emailTransport(config.resendKey, config.emailFrom, fetchImpl)
  if (config.telegramToken) {
    try {
      out.telegram = await buildTelegram(config.telegramToken, fetchImpl)
    } catch (err) {
      console.error('[notify] Telegram disabled:', err instanceof DeliveryError ? err.message : 'unexpected error')
    }
  }
  return out
}

export { emailTransport }
