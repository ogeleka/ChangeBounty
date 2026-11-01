import { motion } from 'framer-motion'
import { ArrowUpRight, Check, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { shortHash } from '@/lib/format'
import type { JobView } from '@/lib/api'

export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 220, damping: 26, delay }}
    >
      {children}
    </motion.div>
  )
}

export function Stat({ label, value, sub, tone = 'ink' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ink' | 'pay' | 'signal' }) {
  const color = tone === 'pay' ? 'text-emerald-300' : tone === 'signal' ? 'text-[#9cc2ff]' : 'text-[#f3f6fb]'
  return (
    <div className="card p-5">
      <div className="label">{label}</div>
      <div className={`display num mt-2 text-3xl font-semibold ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-[#8396b0]">{sub}</div>}
    </div>
  )
}

export function TxLink({ chainId, hash, label }: { chainId: number; hash: string; label?: string }) {
  return (
    <a
      href={buildTxExplorerUrl(chainId, hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="mono inline-flex items-center gap-1 rounded-md text-[13px] text-[#9cc2ff] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#85b1ed]"
    >
      {label ?? shortHash(hash)}
      <ArrowUpRight size={13} aria-hidden />
    </a>
  )
}

type Pill = { text: string; cls: string; dot: string }

export function jobPill(job: JobView): Pill {
  if (job.chain?.status === 'Cancelled') return { text: 'Cancelled', cls: 'bg-white/5 text-[#a9b6c9]', dot: 'bg-[#7587a0]' }
  if (job.monitoring === 'rejected') return { text: 'Not monitored', cls: 'bg-white/5 text-[#a9b6c9]', dot: 'bg-[#7587a0]' }
  if (job.monitoring === 'invalid_url') return { text: 'URL rejected', cls: 'bg-rose-400/10 text-rose-200', dot: 'bg-rose-300' }
  if (job.monitoring === 'paused') return { text: 'Paused', cls: 'bg-amber-300/10 text-amber-200', dot: 'bg-amber-300' }
  return { text: 'Monitoring', cls: 'bg-emerald-400/10 text-emerald-300', dot: 'bg-emerald-400' }
}

export function StatusPill({ job }: { job: JobView }) {
  const p = jobPill(job)
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${p.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${p.dot} ${p.text === 'Monitoring' ? 'live-dot' : ''}`} />
      {p.text}
    </span>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <div className="display text-xl font-semibold">{title}</div>
      {children && <div className="mt-2 max-w-md text-[15px] text-[#8396b0]">{children}</div>}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-[#a9b6c9]" role="status">
      <Loader2 className="animate-spin" size={16} aria-hidden />
      {label}
    </span>
  )
}

export function StepDot({ state }: { state: 'done' | 'active' | 'todo' | 'error' }) {
  if (state === 'done')
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-400 text-[#052018]">
        <Check size={15} strokeWidth={3} aria-hidden />
      </span>
    )
  if (state === 'active')
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full border border-[#85b1ed] bg-[#85b1ed]/10 text-[#9cc2ff]">
        <Loader2 size={15} className="animate-spin" aria-hidden />
      </span>
    )
  if (state === 'error') return <span className="grid h-7 w-7 place-items-center rounded-full border border-rose-300/50 text-rose-200">!</span>
  return <span className="h-7 w-7 rounded-full border border-white/15" />
}
