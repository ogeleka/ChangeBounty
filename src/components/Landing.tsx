import { ArrowRight, Eye, Fingerprint, Landmark, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal, TxLink } from '@/components/ui'
import { useAppConfig, usePayments } from '@/lib/api'
import { hostOf, shortHash, timeAgo, usdc } from '@/lib/format'
import { useJobs } from '@/lib/api'

function ProofCard() {
  const { data: payments } = usePayments()
  const { data: jobs } = useJobs(8000)
  const { data: cfg } = useAppConfig()
  const latest = payments?.[0]
  const job = latest ? jobs?.find((j) => j.id === latest.jobId) : undefined

  return (
    <div className="card-solid relative overflow-hidden p-6 sm:p-7">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
        <div className="h-px w-1/2 bg-gradient-to-r from-transparent via-[#7fb0ff] to-transparent" style={{ animation: 'scan 3.2s linear infinite' }} />
      </div>
      <div className="label">Latest verified payout</div>
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
      ) : (
        <div className="mt-5 space-y-3">
          <div className="display text-3xl font-semibold text-[#e3ecf9]">Waiting for the first change.</div>
          <p className="text-[15px] text-[#8396b0]">
            Nothing is shown here until a real payout lands onchain. Run the live demo to produce one.
          </p>
        </div>
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
