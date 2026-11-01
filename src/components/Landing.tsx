import { ArrowRight, Bell, Briefcase, Eye, Fingerprint, Gavel, Landmark, ScrollText, ShieldCheck, Tags } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal, TxLink } from '@/components/ui'
import { useAppConfig, useJobs, usePayments } from '@/lib/api'
import { hostOf, shortAddr, shortHash, timeAgo, usdc } from '@/lib/format'
import { buildAddressExplorerUrl } from '@/onchain-facts'

function ProofCard() {
  const { data: payments } = usePayments()
  const { data: jobs } = useJobs(8000)
  const { data: cfg, isError } = useAppConfig()
  const latest = payments?.[0]
  const job = latest ? jobs?.find((j) => j.id === latest.jobId) : undefined

  return (
    <div className="card-solid relative overflow-hidden p-6 sm:p-7">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
        <div className="h-px w-1/2 bg-gradient-to-r from-transparent via-[#7fb0ff] to-transparent" style={{ animation: 'scan 3.2s linear infinite' }} />
      </div>
      {latest && <div className="label">Latest verified payout</div>}
      {!latest && <div className="label">System status</div>}
      {latest && cfg ? (
        <div className="mt-5 space-y-5">
          <div className="display num text-5xl font-semibold text-emerald-300">+{usdc(latest.rewardRaw)} <span className="text-2xl text-emerald-300/70">USDC</span></div>
          <div className="space-y-3 rounded-xl bg-white/[0.04] p-4">
            <Row k="Page" v={job ? hostOf(job.url) : `Job #${latest.jobId}`} />
            <Row k="Before" v={<span className="mono text-[#a9b6c9]">{shortHash(latest.baselineHash, 8, 4)}</span>} />
            <Row k="After" v={<span className="mono text-[#9cc2ff]">{shortHash(latest.newHash, 8, 4)}</span>} />
            <Row k="Confirmed" v={timeAgo(latest.paidAt)} />
          </div>
          {latest.txHash && <TxLink chainId={cfg.chainId} hash={latest.txHash} label={`Tx ${shortHash(latest.txHash)}`} />}
        </div>
      ) : cfg ? (
        <div className="mt-5 space-y-5">
          <div className="flex items-center gap-2.5">
            <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
            <span className="display text-2xl font-semibold text-[#e3ecf9]">Live on {cfg.network === 'mainnet' ? 'Arc mainnet' : cfg.chainName}</span>
          </div>
          <div className="space-y-3 rounded-xl bg-white/[0.04] p-4">
            {cfg.contract && (
              <Row
                k="Contract"
                v={
                  <a className="mono text-[#9cc2ff] hover:underline" href={buildAddressExplorerUrl(cfg.chainId, cfg.contract)} target="_blank" rel="noopener noreferrer">
                    {shortAddr(cfg.contract)}
                  </a>
                }
              />
            )}
            <Row k="Verifier" v={cfg.verifierReady ? <span className="text-emerald-300">Ready</span> : <span className="text-amber-200">Not configured</span>} />
            <Row k="Page checks" v={`Every ${cfg.pollIntervalSec} seconds`} />
            <Row k="Jobs watched" v={<span className="num">{jobs?.filter((j) => j.monitoring === 'active').length ?? '…'}</span>} />
          </div>
          <p className="text-[15px] text-[#8396b0]">
            No payout yet. The first verified change will appear here with its transaction.{' '}
            <Link to="/demo" className="text-[#9cc2ff] hover:underline">Run the live demo</Link>
          </p>
        </div>
      ) : (
        <p className="mt-5 text-[15px] text-[#8396b0]">{isError ? 'The ChangeBounty service is unreachable right now. Please try again shortly.' : 'Loading live status…'}</p>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-[#7587a0]">{k}</span>
      <span className="truncate text-right text-[#e3ecf9]">{v}</span>
    </div>
  )
}

const USES = [
  { icon: Gavel, title: 'Procurement tenders', body: 'A new tender is posted on a public procurement portal.' },
  { icon: Tags, title: 'Prices and terms', body: 'A supplier changes its price list or its terms of service.' },
  { icon: ScrollText, title: 'Announcements', body: 'A project publishes a release note, an incident report or a policy update.' },
  { icon: Briefcase, title: 'Job postings', body: 'A company opens a new role on its careers page.' },
]

function AlertsBand() {
  const { data: cfg } = useAppConfig()
  const alerts = cfg?.alerts
  if (!alerts || (!alerts.telegramBot && !alerts.email)) return null
  const channels = [alerts.telegramBot && 'Telegram', alerts.email && 'email'].filter(Boolean).join(' or ')
  return (
    <Reveal>
      <section className="card flex flex-col gap-6 p-8 sm:flex-row sm:items-center" aria-labelledby="alerts">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#85b1ed]/10 text-[#9cc2ff]">
          <Bell size={22} aria-hidden />
        </span>
        <div>
          <h2 id="alerts" className="display text-2xl font-semibold">Hear about it first.</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-[#a9b6c9]">
            Get a message on {channels} when a change is confirmed and paid, when a job runs low on USDC, or when a new verifier is proposed. Turn it on from
            any job you created.
          </p>
        </div>
      </section>
    </Reveal>
  )
}

const STEPS = [
  { icon: Landmark, title: 'Fund a job', body: 'Pick a public page and a fixed USDC reward. Your escrow stays yours until it is paid out.' },
  { icon: Eye, title: 'Agent watches', body: 'The first fetch sets a baseline. After that, every real text change is a candidate discovery.' },
  { icon: ShieldCheck, title: 'Verifier confirms', body: 'A separate service re-fetches the page itself and only signs off when it sees the same change.' },
  { icon: Fingerprint, title: 'Contract pays', body: 'The contract sends the fixed reward once per discovery. No repeats, no surprises.' },
]

export default function Landing() {
  return (
    <div className="space-y-24">
      <section className="grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
        <Reveal>
          <div className="label mb-5 text-[#9cc2ff]">Website monitoring, paid in USDC on Arc</div>
          <h1 className="display text-balance text-5xl font-semibold leading-[1.02] sm:text-6xl lg:text-7xl">
            When the internet changes, <span className="text-emerald-300">agents get paid.</span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-[#a9b6c9]">
            Fund a monitoring job, let an automated agent watch any public page, and release a fixed USDC reward only when an independent verifier
            confirms the change.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link to="/create" className="btn-primary">
              Create a job <ArrowRight size={16} aria-hidden />
            </Link>
            <Link to="/demo" className="btn-ghost">Watch the live demo</Link>
          </div>
        </Reveal>
        <Reveal delay={0.08}>
          <ProofCard />
        </Reveal>
      </section>

      <section aria-labelledby="how">
        <h2 id="how" className="display text-3xl font-semibold sm:text-4xl">One journey, four checkpoints.</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.05}>
              <div className="card h-full p-6">
                <div className="mb-5 flex items-center justify-between">
                  <s.icon size={22} className="text-[#9cc2ff]" aria-hidden />
                  <span className="mono text-xs text-[#5f7189]">0{i + 1}</span>
                </div>
                <h3 className="display text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-[#8396b0]">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section aria-labelledby="uses">
        <h2 id="uses" className="display text-3xl font-semibold sm:text-4xl">Watch the pages that matter.</h2>
        <p className="mt-3 max-w-2xl text-[15px] text-[#8396b0]">Any public page with text works. A few examples:</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USES.map((u, i) => (
            <Reveal key={u.title} delay={i * 0.05}>
              <div className="h-full rounded-2xl border border-white/10 p-5">
                <u.icon size={20} className="text-emerald-300" aria-hidden />
                <h3 className="mt-4 font-semibold text-[#e3ecf9]">{u.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[#8396b0]">{u.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <AlertsBand />

      <section className="grid gap-6 lg:grid-cols-2" aria-labelledby="trust">
        <div className="card p-8">
          <h2 id="trust" className="display text-2xl font-semibold">What the contract guarantees</h2>
          <ul className="mt-5 space-y-3 text-[15px] text-[#a9b6c9]">
            <li>Only the verifier can authorise a payout, and only the fixed reward goes to the job's agent.</li>
            <li>Each discovery id can be paid once. Repeats revert.</li>
            <li>Creators can cancel at any time and withdraw whatever is left.</li>
            <li>Reentrancy guarded, with safe ERC-20 transfers on Arc's native USDC.</li>
          </ul>
        </div>
        <div className="card p-8">
          <h2 className="display text-2xl font-semibold">What you are trusting</h2>
          <p className="mt-5 text-[15px] leading-relaxed text-[#a9b6c9]">
            Whether a website really changed is not something a contract can see. ChangeBounty relies on a trusted verifier service for that. If the
            verifier were compromised, the most it could do is pay fixed rewards from funded jobs to their configured agents. Your funds stay bounded to the
            escrow you chose, and you can cancel and withdraw.
          </p>
        </div>
      </section>
    </div>
  )
}
