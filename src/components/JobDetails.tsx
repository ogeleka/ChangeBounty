import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import JobTimeline from '@/components/JobTimeline'
import { Empty, Reveal, Spinner, Stat, StatusPill, TxLink } from '@/components/ui'
import { describeError, useBounty } from '@/hooks/useBounty'
import { ApiError, postJson, useJob, type Discovery, type JobView } from '@/lib/api'
import { safeHref, shortAddr, shortHash, timeAgo, usdc } from '@/lib/format'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { parseUsdc } from '@/onchain-money'

const DISCOVERY_LABEL: Record<Discovery['status'], string> = {
  detected: 'Detected',
  verifying: 'Verifying',
  verified: 'Verified',
  paid: 'Paid',
  rejected: 'Rejected',
  failed: 'Failed',
}

function DiscoveryCard({ d, chainId }: { d: Discovery; chainId: number }) {
  const tone = d.status === 'paid' ? 'bg-emerald-400/10 text-emerald-300' : d.status === 'rejected' || d.status === 'failed' ? 'bg-rose-400/10 text-rose-200' : 'bg-[#85b1ed]/10 text-[#9cc2ff]'
  return (
    <div className="card-solid p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="mono text-[13px] text-[#a9b6c9]">{shortHash(d.id, 10, 6)}</div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>{DISCOVERY_LABEL[d.status]}</span>
      </div>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Snippet title="Added" lines={d.added} sign="+" tone="text-emerald-300" />
        <Snippet title="Removed" lines={d.removed} sign="-" tone="text-rose-200" />
      </div>
      <div className="mono mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#7587a0]">
        <span>before {shortHash(d.baselineHash, 8, 4)}</span>
        <span>after {shortHash(d.newHash, 8, 4)}</span>
        {d.verifierHash && <span>verifier saw {shortHash(d.verifierHash, 8, 4)}</span>}
      </div>
      {d.reason && d.status !== 'paid' && <p className="mt-3 text-sm text-rose-200">{d.reason}</p>}
      {d.txHash && (
        <div className="mt-4 flex items-center gap-3 border-t border-white/10 pt-4">
          <span className="num text-sm font-semibold text-emerald-300">+{usdc(d.rewardRaw)} USDC</span>
          <TxLink chainId={chainId} hash={d.txHash} />
        </div>
      )}
    </div>
  )
}

function Snippet({ title, lines, sign, tone }: { title: string; lines: string[]; sign: string; tone: string }) {
  return (
    <div className="rounded-xl bg-white/[0.04] p-3">
      <div className="label mb-2">{title}</div>
      {lines.length === 0 ? (
        <div className="text-[#5f7189]">Nothing</div>
      ) : (
        <ul className="space-y-1.5">
          {lines.slice(0, 4).map((l, i) => (
            <li key={i} className={`break-words text-[13px] leading-snug ${tone}`}>{sign} {l}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreatorPanel({ job }: { job: JobView }) {
  const b = useBounty()
  const qc = useQueryClient()
  const [amount, setAmount] = useState('0.05')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hash?: string } | null>(null)
  const jobId = BigInt(job.id)
  const balance = BigInt(job.chain?.balanceRaw ?? '0')
  const cancelled = job.chain?.status === 'Cancelled'

  async function act(label: string, fn: () => Promise<{ hash: string }>) {
    setBusy(label)
    setMsg(null)
    try {
      const r = await fn()
      setMsg({ ok: true, text: `${label} confirmed.`, hash: r.hash })
      await qc.invalidateQueries({ queryKey: ['job', job.id] })
      void b.refetchBalance()
    } catch (err) {
      setMsg({ ok: false, text: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  async function topUp() {
    let raw: bigint
    try {
      raw = parseUsdc(amount)
    } catch {
      setMsg({ ok: false, text: 'Enter a valid USDC amount.' })
      return
    }
    if (raw <= 0n) return setMsg({ ok: false, text: 'Enter an amount above zero.' })
    await act('Top up', async () => {
      if ((await b.allowance()) < raw) await b.approve(raw)
      return b.fundJob(jobId, raw)
    })
  }

  return (
    <div className="card-solid space-y-5 p-6">
      <div>
        <h3 className="display text-xl font-semibold">Manage your job</h3>
        <p className="mt-1 text-sm text-[#8396b0]">Only the wallet that created this job can do this.</p>
      </div>
      {!cancelled && (
        <div className="flex gap-3">
          <input aria-label="Top up amount in USDC" className="field num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button type="button" className="btn-primary shrink-0" disabled={busy !== null || b.wrongChain} onClick={() => void topUp()}>
            {busy === 'Top up' ? 'Working…' : 'Add USDC'}
          </button>
        </div>
      )}
      {b.wrongChain ? (
        <button type="button" className="btn-primary w-full" onClick={() => void b.switchToApp()}>Switch to {b.cfg?.chainName}</button>
      ) : !cancelled ? (
        <button
          type="button"
          className="btn-danger w-full"
          disabled={busy !== null}
          onClick={() => void act(balance > 0n ? 'Cancel and withdraw' : 'Cancel', () => (balance > 0n ? b.cancelAndWithdraw(jobId) : b.cancelJob(jobId)))}
        >
          {busy?.startsWith('Cancel') ? 'Confirm in your wallet…' : balance > 0n ? `Cancel and withdraw ${usdc(balance)} USDC` : 'Cancel job'}
        </button>
      ) : balance > 0n ? (
        <button type="button" className="btn-pay w-full" disabled={busy !== null} onClick={() => void act('Withdraw', () => b.withdrawUnused(jobId))}>
          {busy === 'Withdraw' ? 'Confirm in your wallet…' : `Withdraw ${usdc(balance)} USDC`}
        </button>
      ) : (
        <p className="text-sm text-[#8396b0]">This job is cancelled and has no funds left.</p>
      )}
      {msg && (
        <p role="status" className={`text-sm ${msg.ok ? 'text-emerald-300' : 'text-rose-200'}`}>
          {msg.text} {msg.hash && b.cfg && <TxLink chainId={b.cfg.chainId} hash={msg.hash} />}
        </p>
      )}
    </div>
  )
}

export default function JobDetails() {
  const { id } = useParams()
  const { data: job, error, isLoading } = useJob(id)
  const b = useBounty()
  const qc = useQueryClient()
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState<string | null>(null)

  if (isLoading) return <Spinner label="Loading job" />
  if (error || !job || !b.cfg) {
    return (
      <Empty title="Job not found">
        {error instanceof ApiError ? error.message : 'It may not be registered with the monitor yet.'}{' '}
        <Link className="text-[#9cc2ff] hover:underline" to="/dashboard">Back to dashboard</Link>
      </Empty>
    )
  }
  const cfg = b.cfg
  const paid = job.discoveries.filter((d) => d.status === 'paid')
  const isCreator = Boolean(b.address && b.address.toLowerCase() === job.creator.toLowerCase())

  async function checkNow() {
    setChecking(true)
    setCheckErr(null)
    try {
      await postJson(`/api/jobs/${job!.id}/check`, {})
      await qc.invalidateQueries({ queryKey: ['job', job!.id] })
    } catch (err) {
      setCheckErr(err instanceof Error ? err.message : 'Check failed.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-8">
      <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-[#8396b0] hover:text-white"><ArrowLeft size={15} aria-hidden />Dashboard</Link>
      <Reveal className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3"><StatusPill job={job} /><span className="label">Job #{job.id}</span></div>
          <h1 className="display mt-3 break-words text-3xl font-semibold sm:text-4xl">{job.url}</h1>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[#8396b0]">
            <span>Creator <a className="mono text-[#9cc2ff] hover:underline" href={buildAddressExplorerUrl(cfg.chainId, job.creator)} target="_blank" rel="noopener noreferrer">{shortAddr(job.creator)}</a></span>
            <span>Agent <a className="mono text-[#9cc2ff] hover:underline" href={buildAddressExplorerUrl(cfg.chainId, job.agent)} target="_blank" rel="noopener noreferrer">{shortAddr(job.agent)}</a></span>
            <TxLink chainId={cfg.chainId} hash={job.createTxHash} label="Creation tx" />
          </div>
        </div>
        <button type="button" className="btn-ghost" onClick={() => void checkNow()} disabled={checking || job.monitoring !== 'active'}>
          <RefreshCw size={15} className={checking ? 'animate-spin' : ''} aria-hidden />Check now
        </button>
      </Reveal>
      {checkErr && <p role="alert" className="text-sm text-rose-200">{checkErr}</p>}
      {job.monitoring !== 'active' && job.monitoringReason && (
        <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">Monitoring is {job.monitoring === 'paused' ? 'paused' : 'off'}: {job.monitoringReason}.</div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Escrow" value={usdc(job.chain?.balanceRaw)} sub="USDC remaining" />
        <Stat label="Reward" value={usdc(job.rewardRaw)} sub="USDC per discovery" tone="signal" />
        <Stat label="Paid" value={usdc(paid.reduce((n, d) => n + BigInt(d.rewardRaw ?? '0'), 0n))} sub={`${paid.length} discoveries`} tone="pay" />
        <Stat label="Checks" value={job.checks} sub={`Last ${timeAgo(job.lastCheckAt)}`} />
      </div>

      <div className="grid gap-8 lg:grid-cols-[1.3fr_0.7fr]">
        <section aria-labelledby="disc" className="space-y-4">
          <h2 id="disc" className="display text-2xl font-semibold">Discoveries</h2>
          {job.discoveries.length === 0 ? (
            <Empty title="No changes detected yet">
              {job.baseline ? `Baseline ${shortHash(job.baseline.hash, 10, 4)} is set. The next real change will appear here.` : 'The first fetch will set the baseline. It is never paid.'}
            </Empty>
          ) : (
            job.discoveries.map((d) => <DiscoveryCard key={d.id} d={d} chainId={cfg.chainId} />)
          )}
        </section>
        <aside className="space-y-6">
          {isCreator && <CreatorPanel job={job} />}
          <section aria-labelledby="tl">
            <h2 id="tl" className="display mb-3 text-2xl font-semibold">Activity</h2>
            <div className="card p-3"><JobTimeline events={job.events} chainId={cfg.chainId} /></div>
          </section>
          {safeHref(job.url) && (
            <a className="inline-flex items-center gap-1.5 text-sm text-[#9cc2ff] hover:underline" href={safeHref(job.url)} target="_blank" rel="noopener noreferrer">Open the monitored page<ExternalLink size={14} aria-hidden /></a>
          )}
        </aside>
      </div>
    </div>
  )
}
