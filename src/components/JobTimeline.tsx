import { AlertCircle, CircleCheck, Eye, Radar, ScanSearch, Wallet } from 'lucide-react'
import type { JobEvent } from '../../server/types'
import { TxLink } from '@/components/ui'
import { clockTime } from '@/lib/format'

const META: Record<JobEvent['type'], { icon: typeof Eye; tone: string }> = {
  registered: { icon: Radar, tone: 'text-[#9cc2ff]' },
  baseline: { icon: Eye, tone: 'text-[#9cc2ff]' },
  check: { icon: Eye, tone: 'text-[#7587a0]' },
  change_detected: { icon: ScanSearch, tone: 'text-amber-200' },
  minor_change: { icon: Eye, tone: 'text-[#7587a0]' },
  verifying: { icon: ScanSearch, tone: 'text-[#9cc2ff]' },
  verified: { icon: CircleCheck, tone: 'text-emerald-300' },
  rejected: { icon: AlertCircle, tone: 'text-rose-200' },
  paid: { icon: Wallet, tone: 'text-emerald-300' },
  paused: { icon: AlertCircle, tone: 'text-amber-200' },
  error: { icon: AlertCircle, tone: 'text-rose-200' },
}

export default function JobTimeline({ events, chainId }: { events: JobEvent[]; chainId: number }) {
  const rows = [...events].reverse().slice(0, 40)
  return (
    <ol className="relative space-y-1">
      {rows.map((e, i) => {
        const m = META[e.type]
        return (
          <li key={`${e.t}-${i}`} className="flex gap-3 rounded-lg px-2 py-2.5">
            <m.icon size={17} className={`mt-0.5 shrink-0 ${m.tone}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-[#e3ecf9]">{e.message}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-[#7587a0]">
                <span className="num mono">{clockTime(e.t)}</span>
                {e.txHash && <TxLink chainId={chainId} hash={e.txHash} />}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
