import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { Empty, Reveal, Spinner, Stat, StatusPill, TxLink } from '@/components/ui'
import { useAppConfig, useJobs, usePayments, type JobView } from '@/lib/api'
import { hostOf, timeAgo, usdc } from '@/lib/format'

function JobRow({ job }: { job: JobView }) {
  const paid = job.discoveries.filter((d) => d.status === 'paid').length
  return (
    <Link
      to={`/jobs/${job.id}`}
      className="grid items-center gap-3 rounded-xl border border-transparent px-4 py-4 transition hover:border-white/10 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#85b1ed] sm:grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr_auto]"
    >
      <div className="min-w-0">
        <div className="truncate font-semibold">{hostOf(job.url)}</div>
        <div className="mt-0.5 text-xs text-[#7587a0]">Job #{job.id} · checked {timeAgo(job.lastCheckAt)}</div>
      </div>
      <Cell label="Escrow" value={`${usdc(job.chain?.balanceRaw)} USDC`} />
      <Cell label="Reward" value={`${usdc(job.rewardRaw)} USDC`} />
      <Cell label="Discoveries" value={`${paid} paid`} />
      <StatusPill job={job} />
    </Link>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label sm:hidden">{label}</div>
      <div className="num text-sm text-[#e3ecf9]">{value}</div>
    </div>
  )
}

export default function Dashboard() {
  const { address } = useAccount()
  const { data: cfg } = useAppConfig()
  const { data: jobs, isLoading, error } = useJobs()
  const { data: payments } = usePayments()
  const [scope, setScope] = useState<'all' | 'mine'>('all')

  const visible = (jobs ?? []).filter((j) => scope === 'all' || (address && j.creator.toLowerCase() === address.toLowerCase()))
  const active = (jobs ?? []).filter((j) => j.monitoring === 'active' && j.chain?.status === 'Active').length
  const escrow = (jobs ?? []).reduce((n, j) => n + BigInt(j.chain?.balanceRaw ?? '0'), 0n)
  const paidTotal = (payments ?? []).reduce((n, d) => n + BigInt(d.rewardRaw ?? '0'), 0n)

  return (
    <div className="space-y-10">
      <Reveal className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label text-[#9cc2ff]">Dashboard</div>
          <h1 className="display mt-2 text-4xl font-semibold sm:text-5xl">Every watch, every payout.</h1>
        </div>
        <Link to="/create" className="btn-primary"><Plus size={16} aria-hidden />New job</Link>
      </Reveal>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active jobs" value={active} sub={`${jobs?.length ?? 0} registered`} tone="signal" />
        <Stat label="USDC in escrow" value={usdc(escrow)} sub="Held by the contract" />
        <Stat label="USDC paid out" value={usdc(paidTotal)} sub={`${payments?.length ?? 0} verified discoveries`} tone="pay" />
      </div>

      <section aria-labelledby="jobs">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="jobs" className="display text-2xl font-semibold">Jobs</h2>
          <div className="flex rounded-xl border border-white/10 p-1" role="tablist" aria-label="Job filter">
            {(['all', 'mine'] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={scope === s}
                onClick={() => setScope(s)}
                className={`min-h-[36px] rounded-lg px-4 text-sm font-medium ${scope === s ? 'bg-white/10 text-white' : 'text-[#8396b0]'}`}
              >
                {s === 'all' ? 'All' : 'Mine'}
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <Spinner label="Loading jobs" />
        ) : error ? (
          <Empty title="The service is unreachable">Start the ChangeBounty server and refresh.</Empty>
        ) : visible.length === 0 ? (
          <Empty title={scope === 'mine' ? 'No jobs from this wallet yet' : 'No jobs yet'}>
            Create a job to start watching a page. Your first fetch only sets a baseline and costs nothing.
          </Empty>
        ) : (
          <div className="card divide-y divide-white/5 p-2">
            {visible.map((j) => <JobRow key={j.id} job={j} />)}
          </div>
        )}
      </section>

      <section aria-labelledby="pay">
        <h2 id="pay" className="display mb-4 text-2xl font-semibold">Payment history</h2>
        {!payments || payments.length === 0 ? (
          <Empty title="No payouts yet">Each verified discovery appears here with its onchain transaction.</Empty>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="label border-b border-white/10">
                  <th className="px-5 py-3 font-semibold">When</th>
                  <th className="px-5 py-3 font-semibold">Job</th>
                  <th className="px-5 py-3 text-right font-semibold">Amount</th>
                  <th className="px-5 py-3 font-semibold">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-white/5 last:border-0">
                    <td className="px-5 py-3.5 text-[#a9b6c9]">{timeAgo(p.paidAt)}</td>
                    <td className="px-5 py-3.5"><Link className="text-[#9cc2ff] hover:underline" to={`/jobs/${p.jobId}`}>#{p.jobId}</Link></td>
                    <td className="num px-5 py-3.5 text-right font-semibold text-emerald-300">+{usdc(p.rewardRaw)}</td>
                    <td className="px-5 py-3.5">{p.txHash && cfg && <TxLink chainId={cfg.chainId} hash={p.txHash} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
