import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ConnectKitButton } from 'connectkit'
import { AlertTriangle, CheckCircle2, Globe } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Address } from 'viem'
import { StepDot, Reveal, TxLink } from '@/components/ui'
import { describeError, jobIdFromReceipt, useBounty } from '@/hooks/useBounty'
import { postJson } from '@/lib/api'
import { usdc } from '@/lib/format'
import { parseUsdc } from '@/onchain-money'

type Phase = 'idle' | 'approving' | 'creating' | 'registering' | 'done'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function safeParse(text: string): bigint | null {
  try {
    const v = parseUsdc(text.trim())
    return v > 0n ? v : null
  } catch {
    return null
  }
}

export default function CreateJob() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const b = useBounty()
  const cfg = b.cfg

  const [url, setUrl] = useState(params.get('demo') ? '' : (params.get('url') ?? ''))
  const [reward, setReward] = useState('0.01')
  const [funding, setFunding] = useState('0.03')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [hashes, setHashes] = useState<{ approve?: string; create?: string }>({})

  const effectiveUrl = params.get('demo') && !url && cfg ? cfg.demoUrl : url
  const debouncedUrl = useDebounced(effectiveUrl.trim(), 450)
  const check = useQuery({
    queryKey: ['validate', debouncedUrl],
    queryFn: () => postJson<{ ok: boolean; reason?: string; url?: string }>('/api/validate-url', { url: debouncedUrl }),
    enabled: debouncedUrl.length > 0,
    staleTime: 30_000,
  })

  const rewardRaw = safeParse(reward)
  const fundingRaw = funding.trim() === '' || funding.trim() === '0' ? 0n : safeParse(funding)
  const covers = rewardRaw && fundingRaw !== null ? fundingRaw / rewardRaw : 0n
  const urlOk = debouncedUrl === effectiveUrl.trim() && check.data?.ok === true
  const balanceTooLow = fundingRaw !== null && b.walletBalance !== undefined && fundingRaw > b.walletBalance
  const agent = cfg?.agentAddress as Address | undefined
  const minReward = cfg ? BigInt(cfg.minRewardRaw) : 0n
  const rewardTooLow = rewardRaw !== null && rewardRaw < minReward
  const ready = Boolean(cfg?.contract && agent && urlOk && rewardRaw && !rewardTooLow && fundingRaw !== null && fundingRaw >= (rewardRaw ?? 0n) && !balanceTooLow)
  const busy = phase !== 'idle' && phase !== 'done'

  async function submit() {
    if (!ready || !rewardRaw || fundingRaw === null || !agent) return
    setError(null)
    setHashes({})
    try {
      if (fundingRaw > 0n && (await b.allowance()) < fundingRaw) {
        setPhase('approving')
        const a = await b.approve(fundingRaw)
        setHashes((h) => ({ ...h, approve: a.hash }))
      }
      setPhase('creating')
      // Submit the server-normalised address that passed validation, never the raw text.
      const created = await b.createJob(check.data?.url ?? effectiveUrl.trim(), agent, rewardRaw, fundingRaw)
      setHashes((h) => ({ ...h, create: created.hash }))
      const jobId = jobIdFromReceipt(created.receipt)
      setPhase('registering')
      await postJson('/api/jobs/register', { txHash: created.hash })
      await qc.invalidateQueries({ queryKey: ['jobs'] })
      void b.refetchBalance()
      setPhase('done')
      if (jobId !== undefined) setTimeout(() => void nav(`/jobs/${jobId.toString()}`), 900)
    } catch (err) {
      setError(describeError(err))
      setPhase('idle')
    }
  }

  const steps: Array<{ key: Phase; label: string; hash?: string }> = [
    { key: 'approving', label: 'Allow USDC for this job', hash: hashes.approve },
    { key: 'creating', label: 'Create and fund the job', hash: hashes.create },
    { key: 'registering', label: 'Hand the job to the monitoring agent' },
  ]
  const order: Phase[] = ['idle', 'approving', 'creating', 'registering', 'done']
  const stateOf = (k: Phase) => (order.indexOf(phase) > order.indexOf(k) ? 'done' : phase === k ? 'active' : 'todo')

  return (
    <div className="mx-auto max-w-2xl">
      <Reveal>
        <div className="label text-[#9cc2ff]">New job</div>
        <h1 className="display mt-2 text-4xl font-semibold sm:text-5xl">Pay for the next change.</h1>
        <p className="mt-3 text-[#a9b6c9]">Choose a public page and a fixed reward. The agent is paid once per confirmed change.</p>
      </Reveal>

      {cfg?.network === 'mainnet' && (
        <div className="mt-6 flex gap-3 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
          <p>You are on Arc mainnet. This moves real USDC and transactions cannot be reversed. Start with a small reward.</p>
        </div>
      )}

      <Reveal delay={0.05} className="card-solid mt-8 space-y-7 p-6 sm:p-8">
        <div>
          <label htmlFor="url" className="label">Website address</label>
          <div className="relative mt-2">
            <Globe size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#5f7189]" aria-hidden />
            <input
              id="url"
              className="field !pl-11"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/news"
              value={effectiveUrl}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="mt-2 min-h-[20px] text-sm" aria-live="polite">
            {debouncedUrl && check.isFetching && <span className="text-[#8396b0]">Checking the address…</span>}
            {debouncedUrl && !check.isFetching && check.data?.ok && <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 size={14} aria-hidden />Public page, safe to monitor.</span>}
            {debouncedUrl && !check.isFetching && check.data && !check.data.ok && <span className="text-rose-200">{check.data.reason}</span>}
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="reward" className="label">Reward per discovery (USDC)</label>
            <input id="reward" className="field num mt-2" inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} disabled={busy} />
            <div className="mt-2 flex flex-wrap gap-2">
              {['0.01', '0.05', '0.25', '1'].map((v) => (
                <button key={v} type="button" className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[#a9b6c9] hover:bg-white/10" onClick={() => setReward(v)} disabled={busy}>
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="funding" className="label">Fund the job (USDC)</label>
            <input id="funding" className="field num mt-2" inputMode="decimal" value={funding} onChange={(e) => setFunding(e.target.value)} disabled={busy} />
            <div className="mt-2 flex flex-wrap gap-2">
              {[1n, 3n, 10n].map((n) => (
                <button
                  key={n.toString()}
                  type="button"
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[#a9b6c9] hover:bg-white/10"
                  onClick={() => rewardRaw && setFunding(usdc(rewardRaw * n))}
                  disabled={busy || !rewardRaw}
                >
                  {n.toString()} {n === 1n ? 'reward' : 'rewards'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <dl className="space-y-3 rounded-xl bg-white/[0.04] p-4 text-sm">
          <Line k="Discoveries covered" v={<span className="num">{covers.toString()}</span>} />
          <Line k="Paid to" v={<span className="mono text-[13px]">{agent ? `${agent.slice(0, 8)}…${agent.slice(-6)}` : 'Agent not configured'}</span>} />
          <Line k="Your USDC" v={<span className="num">{b.walletBalance !== undefined ? usdc(b.walletBalance) : b.address ? '…' : 'Connect a wallet'}</span>} />
          <Line k="Network fee" v="Paid in USDC on Arc" />
        </dl>

        {rewardTooLow && <p className="text-sm text-amber-200">The minimum reward is {usdc(minReward)} USDC, so the agent is never paid less than the network work it costs.</p>}
        <p className="text-xs leading-relaxed text-[#7587a0]">Job addresses are written to a public blockchain and shown to everyone. Do not use links that contain tokens, private paths or personal data. Only you can add funds to your job, and you can withdraw what is unused.</p>
        {rewardRaw !== null && fundingRaw !== null && fundingRaw < rewardRaw && fundingRaw !== 0n && <p className="text-sm text-amber-200">Funding is below one reward, so nothing could be paid.</p>}
        {balanceTooLow && <p className="text-sm text-rose-200">Your wallet does not hold enough USDC for this amount.</p>}

        {phase !== 'idle' && (
          <ol className="space-y-3" aria-label="Progress">
            {steps.map((s) => (
              <li key={s.key} className="flex items-center gap-3 text-sm">
                <StepDot state={stateOf(s.key)} />
                <span className={stateOf(s.key) === 'todo' ? 'text-[#5f7189]' : 'text-[#e3ecf9]'}>{s.label}</span>
                {s.hash && cfg && <TxLink chainId={cfg.chainId} hash={s.hash} />}
              </li>
            ))}
          </ol>
        )}
        {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}

        {!b.address ? (
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button type="button" className="btn-primary w-full" onClick={show}>Connect wallet to continue</button>
            )}
          </ConnectKitButton.Custom>
        ) : b.wrongChain ? (
          <button type="button" className="btn-primary w-full" onClick={() => void b.switchToApp()}>Switch to {cfg?.chainName}</button>
        ) : (
          <button type="button" className="btn-pay w-full" disabled={!ready || busy || phase === 'done'} onClick={() => void submit()}>
            {phase === 'approving' ? 'Confirm allowance in your wallet…' : phase === 'creating' ? 'Confirm job in your wallet…' : phase === 'registering' ? 'Starting the agent…' : phase === 'done' ? 'Job live' : `Fund ${funding || '0'} USDC and start`}
          </button>
        )}
      </Reveal>
    </div>
  )
}

function Line({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[#7587a0]">{k}</dt>
      <dd className="text-[#e3ecf9]">{v}</dd>
    </div>
  )
}

