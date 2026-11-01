import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Mail, Send } from 'lucide-react'
import { useState } from 'react'
import { useSignMessage } from 'wagmi'
import { describeError } from '@/hooks/useBounty'
import { alertMessage, isValidEmail, normaliseEmail, type AlertAction } from '@/lib/alertMessage'
import { api, postJson, useAppConfig, type AlertStatus } from '@/lib/api'

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Telegram and email alerts for every job created by the connected wallet. Shown to the job's creator only. */
export default function AlertsPanel({ address }: { address: string }) {
  const { data: cfg } = useAppConfig()
  const qc = useQueryClient()
  const { signMessageAsync } = useSignMessage()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [telegramUrl, setTelegramUrl] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)

  const status = useQuery({
    queryKey: ['alerts', address.toLowerCase()],
    queryFn: () => api<AlertStatus>(`/api/alerts/status?address=${address}`),
    // Poll while waiting for the person to press Start in Telegram or click the email link.
    refetchInterval: (q) => ((telegramUrl && !q.state.data?.telegram) || q.state.data?.email === 'pending' ? 3000 : false),
  })

  const alerts = cfg?.alerts
  if (!cfg || !alerts || (!alerts.telegramBot && !alerts.email)) return null
  const { site } = alerts
  const { chainId } = cfg
  const s = status.data

  async function signed(action: AlertAction, withEmail?: string) {
    const req = { action, address, email: withEmail, site, chainId, issuedAt: new Date().toISOString(), nonce: nonce() }
    const signature = await signMessageAsync({ message: alertMessage(req) })
    return { ...req, signature }
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['alerts', address.toLowerCase()] })
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  const connectTelegram = () =>
    run('telegram', async () => {
      const r = await postJson<{ url: string }>('/api/alerts/telegram', await signed('link-telegram'))
      setTelegramUrl(r.url)
    })

  const subscribe = () =>
    run('email', async () => {
      const value = normaliseEmail(email)
      if (!isValidEmail(value)) throw new Error('Enter a valid email address.')
      await postJson('/api/alerts/email', await signed('subscribe-email', value))
      setSentTo(value)
    })

  const turnOff = (channel: 'telegram' | 'email') =>
    run(`off-${channel}`, async () => {
      await postJson('/api/alerts/unsubscribe', { ...(await signed(channel === 'telegram' ? 'unsubscribe-telegram' : 'unsubscribe-email')), channel })
      if (channel === 'telegram') setTelegramUrl(null)
      else setSentTo(null)
    })

  return (
    <div className="card-solid space-y-5 p-6">
      <div>
        <h3 className="display flex items-center gap-2 text-xl font-semibold"><Bell size={18} aria-hidden />Alerts</h3>
        <p className="mt-1 text-sm text-[#8396b0]">Get a message when a change is confirmed and paid, or when a job needs attention. Covers every job created by this wallet.</p>
      </div>

      {alerts.telegramBot && (
        <div className="space-y-2">
          <div className="label flex items-center gap-1.5"><Send size={13} aria-hidden />Telegram</div>
          {s?.telegram ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-emerald-300">Connected</span>
              <button type="button" className="btn-ghost !min-h-[36px] !px-3 text-sm" disabled={busy !== null} onClick={() => void turnOff('telegram')}>
                {busy === 'off-telegram' ? 'Sign in your wallet…' : 'Turn off'}
              </button>
            </div>
          ) : telegramUrl ? (
            <div className="space-y-2">
              <a className="btn-primary w-full" href={telegramUrl} target="_blank" rel="noopener noreferrer">Open Telegram and press Start</a>
              <p className="text-xs text-[#7587a0]">Waiting for Telegram… The link works once and expires in 15 minutes.</p>
            </div>
          ) : (
            <button type="button" className="btn-primary w-full" disabled={busy !== null} onClick={() => void connectTelegram()}>
              {busy === 'telegram' ? 'Sign in your wallet…' : 'Connect Telegram'}
            </button>
          )}
        </div>
      )}

      {alerts.email && (
        <div className="space-y-2">
          <div className="label flex items-center gap-1.5"><Mail size={13} aria-hidden />Email</div>
          {s?.email === 'confirmed' ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-emerald-300">On</span>
              <button type="button" className="btn-ghost !min-h-[36px] !px-3 text-sm" disabled={busy !== null} onClick={() => void turnOff('email')}>
                {busy === 'off-email' ? 'Sign in your wallet…' : 'Turn off'}
              </button>
            </div>
          ) : (
            <>
              {s?.email === 'pending' && (
                <p className="text-sm text-amber-200">Check {sentTo ?? 'your inbox'} for a confirmation link (and your spam folder). Alerts start once you confirm.</p>
              )}
              <div className="flex gap-2">
                <input
                  aria-label="Email address for alerts"
                  className="field"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy !== null}
                />
                <button type="button" className="btn-primary shrink-0" disabled={busy !== null || email.trim() === ''} onClick={() => void subscribe()}>
                  {busy === 'email' ? 'Sign…' : s?.email === 'pending' ? 'Resend' : 'Email me'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-[#7587a0]">Your wallet asks you to sign a message to prove you own these jobs. Signing is free and sends no transaction. Your Telegram chat and email address stay on the ChangeBounty server and are never written onchain.</p>
      {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
    </div>
  )
}
