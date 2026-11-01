import { formatUsdc } from '@/onchain-money'

export const shortHash = (h: string, head = 8, tail = 6) => (h.length > head + tail + 2 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h)
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Format a raw 6-decimal USDC amount (string or bigint) as "1.25". Trims trailing zeros, keeps at least 2 decimals. */
export function usdc(raw: string | bigint | undefined | null): string {
  if (raw === undefined || raw === null || raw === '') return '0.00'
  const text = formatUsdc(typeof raw === 'bigint' ? raw : BigInt(raw))
  const [whole, frac = ''] = text.split('.')
  const trimmed = frac.replace(/0+$/, '')
  return `${whole}.${trimmed.padEnd(2, '0')}`
}

export function timeAgo(ms: number | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Returns the URL only when it is plain http(s). Job addresses come from a public blockchain and are untrusted. */
export function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}
