import { config } from './config'
import { redact } from './redact'

/**
 * Minimal Telegram Bot API client using long polling (getUpdates), so no public webhook or proxy change is
 * needed. The bot token is part of every request URL, so raw fetch errors are never logged or rethrown.
 */

const API = 'https://api.telegram.org'
const MAX_TEXT = 4000

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message)
  }
}

export const telegram = { botUsername: null as string | null }

interface ApiResponse<T> {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  if (!config.telegramToken) throw new TelegramError(0, 'Telegram is not configured.')
  let res: Response
  try {
    res = await fetch(`${API}/bot${config.telegramToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new TelegramError(0, `Could not reach the Telegram API (${method}).`)
  }
  const data = (await res.json().catch(() => ({}))) as ApiResponse<T>
  if (!data.ok) throw new TelegramError(data.error_code ?? res.status, redact(data.description ?? `HTTP ${res.status}`), data.parameters?.retry_after)
  return data.result as T
}

export function sendTelegram(chatId: number, text: string): Promise<unknown> {
  return call('sendMessage', {
    chat_id: chatId,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    link_preview_options: { is_disabled: true },
  })
}

interface Update {
  update_id: number
  message?: { text?: string; chat?: { id: number } }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Connects the bot and handles incoming messages until the process exits. `onMessage` returns the reply
 * text (or null for none). `offset` reads and stores the last processed update so a restart never replays.
 */
export function startTelegram(
  onMessage: (chatId: number, text: string) => Promise<string | null>,
  offset: { get(): number | undefined; set(n: number): void },
): void {
  if (!config.telegramToken) return
  void (async () => {
    let backoff = 5_000
    while (!telegram.botUsername) {
      try {
        const me = await call<{ username?: string }>('getMe', {})
        // Long polling and a webhook cannot both be active for one bot.
        await call('deleteWebhook', {})
        telegram.botUsername = me.username ?? null
        console.log(`[telegram] connected as @${telegram.botUsername}`)
      } catch (err) {
        console.error('[telegram] not connected yet:', err instanceof Error ? err.message : 'unknown error')
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 300_000)
      }
    }
    backoff = 5_000
    for (;;) {
      try {
        const updates = await call<Update[]>('getUpdates', { offset: offset.get() ?? 0, timeout: 25, allowed_updates: ['message'] }, 35_000)
        backoff = 5_000
        for (const u of updates) {
          offset.set(u.update_id + 1)
          const chatId = u.message?.chat?.id
          const text = u.message?.text
          if (typeof chatId !== 'number' || typeof text !== 'string') continue
          const reply = await onMessage(chatId, text).catch(() => 'Something went wrong. Please try again in a minute.')
          if (reply) await sendTelegram(chatId, reply).catch(() => undefined)
        }
      } catch (err) {
        // 409: another process is polling with the same bot token (for example a local copy of the app).
        const message = err instanceof TelegramError && err.code === 409 ? 'another process is using this bot token' : err instanceof Error ? err.message : 'unknown error'
        console.error('[telegram] polling paused:', message)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 120_000)
      }
    }
  })()
}
