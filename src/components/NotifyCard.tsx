import { Bell, Mail, Send } from 'lucide-react'
import { useState } from 'react'
import { ApiError, postJson, useAppConfig } from '@/lib/api'

type Status = { kind: 'ok' | 'error'; text: string } | null

/** Lets anyone following a job get email or Telegram alerts. Shown only for channels the server has enabled. */
export default function NotifyCard({ jobId }: { jobId: string }) {
  const { data: cfg } = useAppConfig()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<'email' | 'telegram' | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [tgUrl, setTgUrl] = useState<string | null>(null)

  const n = cfg?.notifications
  if (!n || (!n.email && !n.telegramBot)) return null

  async function subscribeEmail() {
    setBusy('email')
    setStatus(null)
    try {
      const r = await postJson<{ message: string }>(`/api/jobs/${jobId}/subscribe/email`, { email })
      setStatus({ kind: 'ok', text: r.message })
      setEmail('')
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not subscribe.' })
    } finally {
      setBusy(null)
    }
  }

  async function telegramLink() {
    setBusy('telegram')
    setStatus(null)
    try {
      const r = await postJson<{ url: string }>(`/api/jobs/${jobId}/subscribe/telegram`, {})
      // Only ever open a Telegram link returned by our own server.
      if (!r.url.startsWith('https://t.me/')) throw new ApiError('Unexpected link.')
      setTgUrl(r.url)
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not create the Telegram link.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="notify" className="card-solid space-y-4 p-6">
      <div>
        <h3 id="notify" className="display flex items-center gap-2 text-xl font-semibold"><Bell size={18} className="text-[#9cc2ff]" aria-hidden />Get alerts</h3>
        <p className="mt-1 text-sm text-[#8396b0]">Hear when a change is detected, when the reward is paid, or when the job needs attention.</p>
      </div>

      {n.email && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void subscribeEmail()
          }}
        >
          <label htmlFor="notify-email" className="label">Email</label>
          <div className="flex gap-2">
            <input id="notify-email" type="email" autoComplete="email" required maxLength={254} className="field" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy !== null} />
            <button type="submit" className="btn-primary shrink-0" disabled={busy !== null || email.trim() === ''}>
              <Mail size={15} aria-hidden />{busy === 'email' ? 'Sending…' : 'Notify me'}
            </button>
          </div>
        </form>
      )}

      {n.telegramBot && (
        <div className="space-y-2">
          <div className="label">Telegram</div>
          {tgUrl ? (
            <a className="btn-pay w-full" href={tgUrl} target="_blank" rel="noopener noreferrer"><Send size={15} aria-hidden />Open Telegram and press Start</a>
          ) : (
            <button type="button" className="btn-ghost w-full" disabled={busy !== null} onClick={() => void telegramLink()}>
              <Send size={15} aria-hidden />{busy === 'telegram' ? 'Preparing…' : 'Telegram alerts'}
            </button>
          )}
        </div>
      )}

      {status && <p role="status" className={`text-sm ${status.kind === 'ok' ? 'text-emerald-300' : 'text-rose-200'}`}>{status.text}</p>}
      <p className="text-xs leading-relaxed text-[#7587a0]">We use your address only to send alerts for this job. Every message has an unsubscribe link, and nothing is sent until you confirm.</p>
    </section>
  )
}
