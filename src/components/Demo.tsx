import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Lock, Send } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Reveal, StepDot, TxLink } from '@/components/ui'
import { api, ApiError, postJson, useAppConfig, useJob, useJobs, type Announcement, type JobView } from '@/lib/api'
import { shortHash, usdc } from '@/lib/format'

type StepState = 'done' | 'active' | 'todo' | 'error'
interface Step {
  title: string
  detail: string
  state: StepState
  evidence?: ReactNode
}

function buildSteps(job: JobView | undefined, announcements: Announcement[], chainId: number | undefined): Step[] {
  const d = job?.discoveries[0]
  const baselineAt = job?.baseline?.at
  const published = Boolean(baselineAt && announcements[0] && announcements[0].publishedAt > baselineAt)
  const funded = BigInt(job?.chain?.balanceRaw ?? '0') > 0n
  const raw: Array<Omit<Step, 'state'> & { done: boolean; error?: boolean }> = [
    {
      title: 'Job funded onchain',
      detail: 'USDC is escrowed in the contract for this page.',
      done: funded || Boolean(d),
      evidence: job && chainId ? <TxLink chainId={chainId} hash={job.createTxHash} label={`Create tx ${shortHash(job.createTxHash)}`} /> : undefined,
    },
    {
      title: 'Baseline captured',
      detail: 'The agent fetched the page once. This first fetch is never paid.',
      done: Boolean(job?.baseline),
      evidence: job?.baseline ? <span className="mono text-xs text-[#9cc2ff]">sha256 {shortHash(job.baseline.hash, 12, 6)}</span> : undefined,
    },
    {
      title: 'Website changes',
      detail: 'You publish a real announcement on the public page.',
      done: published || Boolean(d),
      evidence: announcements[0] && published ? <span className="text-xs text-[#a9b6c9]">“{announcements[0].title}”</span> : undefined,
    },
    {
      title: 'Agent detects it',
      detail: 'The hash of the page text no longer matches the baseline.',
      done: Boolean(d),
      evidence: d ? <span className="mono text-xs text-[#9cc2ff]">{shortHash(d.baselineHash, 8, 4)} to {shortHash(d.newHash, 8, 4)}</span> : undefined,
    },
    {
      title: 'Verifier confirms',
      detail: 'A separate service re-fetches the page and must see the same content.',
      done: d?.status === 'verified' || d?.status === 'paid',
      error: d?.status === 'rejected' || d?.status === 'failed',
      evidence: d?.reason && d.status !== 'paid' ? <span className="text-xs text-rose-200">{d.reason}</span> : undefined,
    },
    {
      title: 'USDC paid on Arc',
      detail: 'The contract transfers the fixed reward to the agent.',
      done: d?.status === 'paid' && Boolean(d.txHash),
      evidence:
        d?.txHash && chainId ? (
          <span className="flex flex-wrap items-center gap-3">
            <span className="num text-sm font-semibold text-emerald-300">+{usdc(d.rewardRaw)} USDC</span>
            <TxLink chainId={chainId} hash={d.txHash} label={`Tx ${shortHash(d.txHash)}`} />
          </span>
        ) : undefined,
    },
  ]
  let activeAssigned = false
  return raw.map(({ done, error, ...s }) => {
    let state: StepState = 'todo'
    if (done) state = 'done'
    else if (error) state = 'error'
    else if (!activeAssigned) {
      state = 'active'
      activeAssigned = true
    }
    return { ...s, state }
  })
}

function PublishForm({ onPublished, enabled }: { onPublished: () => void; enabled: boolean }) {
  const [token, setToken] = useState('')
  const [title, setTitle] = useState('Road closure on Harbor Street')
  const [body, setBody] = useState('Harbor Street will be closed to traffic on Saturday morning for the community market.')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function publish() {
    setBusy(true)
    setErr(null)
    try {
      await postJson('/api/demo/publish', { title, body }, { authorization: `Bearer ${token.trim()}` })
      onPublished()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not publish.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card-solid space-y-4 p-6">
      <div className="flex items-center gap-2"><Lock size={16} className="text-[#9cc2ff]" aria-hidden /><h3 className="display text-xl font-semibold">Publish an announcement</h3></div>
      {!enabled && <p className="text-sm text-amber-200">Publishing is disabled until DEMO_ADMIN_TOKEN is set on the server.</p>}
      <div>
        <label className="label" htmlFor="token">Admin token</label>
        <input id="token" type="password" autoComplete="off" className="field mono mt-2" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Held by the demo operator" />
      </div>
      <div>
        <label className="label" htmlFor="title">Title</label>
        <input id="title" className="field mt-2" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="body">Message</label>
        <textarea id="body" className="field mt-2 min-h-[88px] py-3" maxLength={400} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      {err && <p role="alert" className="text-sm text-rose-200">{err}</p>}
      <button type="button" className="btn-pay w-full" disabled={busy || !token.trim() || !enabled} onClick={() => void publish()}>
        <Send size={15} aria-hidden />{busy ? 'Publishing…' : 'Publish to the public page'}
      </button>
    </div>
  )
}

export default function Demo() {
  const qc = useQueryClient()
  const { data: cfg } = useAppConfig()
  const { data: jobs } = useJobs(3000)
  const demoJobs = useMemo(() => (jobs ?? []).filter((j) => cfg && j.url === cfg.demoUrl), [jobs, cfg])
  const [picked, setPicked] = useState<string | null>(null)
  const jobId = picked ?? demoJobs[0]?.id
  const { data: job } = useJob(jobId, 2000)
  const { data: announcements } = useQuery({ queryKey: ['announcements'], queryFn: () => api<Announcement[]>('/api/demo/announcements'), refetchInterval: 3000 })
  const steps = buildSteps(job, announcements ?? [], cfg?.chainId)
  const paid = steps[5].state === 'done'

  async function afterPublish() {
    await qc.invalidateQueries({ queryKey: ['announcements'] })
    if (jobId) {
      // Ask the agent to look now instead of waiting for its next scheduled pass.
      await postJson(`/api/jobs/${jobId}/check`, {}).catch(() => undefined)
      await qc.invalidateQueries({ queryKey: ['job', jobId] })
    }
  }

  return (
    <div className="space-y-10">
      <Reveal>
        <div className="label text-[#9cc2ff]">Live demonstration</div>
        <h1 className="display mt-2 text-balance text-4xl font-semibold sm:text-5xl">Change a real page. Watch a real payout.</h1>
        <p className="mt-3 max-w-2xl text-[#a9b6c9]">Every step below is read from the running agent, the verifier and the chain. Nothing is simulated, and the transaction hash is a real {cfg?.chainName ?? 'Arc'} transaction.</p>
      </Reveal>

      {demoJobs.length === 0 || !job ? (
        <Empty title="Start by funding a demo job">
          The demo watches the announcement page below. Create a job pointed at it, then come back.
          <div className="mt-5"><Link to="/create?demo=1" className="btn-primary">Create the demo job</Link></div>
        </Empty>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-6">
            {demoJobs.length > 1 && (
              <div>
                <label className="label" htmlFor="pick">Demo job</label>
                <select id="pick" className="field mt-2" value={jobId} onChange={(e) => setPicked(e.target.value)}>
                  {demoJobs.map((j) => <option key={j.id} value={j.id}>Job #{j.id} · escrow {usdc(j.chain?.balanceRaw)} USDC</option>)}
                </select>
              </div>
            )}
            <ol className="card-solid divide-y divide-white/5">
              {steps.map((s, i) => (
                <li key={s.title} className="flex gap-4 p-5">
                  <StepDot state={s.state} />
                  <div className="min-w-0 flex-1">
                    <div className={`font-semibold ${s.state === 'todo' ? 'text-[#5f7189]' : 'text-[#f3f6fb]'}`}><span className="mono mr-2 text-xs text-[#5f7189]">0{i + 1}</span>{s.title}</div>
                    <div className="mt-0.5 text-sm text-[#8396b0]">{s.detail}</div>
                    {s.evidence && <div className="mt-2">{s.evidence}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {paid && <Link to={`/jobs/${job.id}`} className="btn-ghost w-full">Open the full job record</Link>}
          </div>

          <div className="space-y-6">
            <PublishForm enabled={cfg?.demoPublishEnabled ?? false} onPublished={() => void afterPublish()} />
            <div className="card-solid overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <span className="label">The monitored page</span>
                <a className="inline-flex items-center gap-1 text-xs text-[#9cc2ff] hover:underline" href="/api/demo-site/announcements" target="_blank" rel="noopener noreferrer">Open <ExternalLink size={12} aria-hidden /></a>
              </div>
              <iframe key={announcements?.[0]?.id ?? 'none'} title="Public announcements page" src="/api/demo-site/announcements" className="site-frame h-[360px] w-full" sandbox="" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
