import { ConnectKitButton } from 'connectkit'
import { ExternalLink, Wallet } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAppConfig } from '@/lib/api'
import { shortAddr } from '@/lib/format'
import { buildAddressExplorerUrl } from '@/onchain-facts'

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="5" y="3" width="22" height="26" rx="5" stroke="#9cc2ff" strokeWidth="2" />
      <path d="M10 11h12M10 16h7" stroke="#9cc2ff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="21.5" cy="21.5" r="3.5" fill="#34d399" />
    </svg>
  )
}

function NetworkBadge() {
  const { data } = useAppConfig()
  if (!data) return null
  const main = data.network === 'mainnet'
  return (
    <span
      className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold sm:inline-flex ${
        main ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-amber-300/30 bg-amber-300/10 text-amber-200'
      }`}
      title={main ? 'Real USDC on Arc mainnet' : 'Test USDC with no real value'}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${main ? 'bg-emerald-400' : 'bg-amber-300'}`} />
      {main ? 'Arc mainnet' : data.chainName}
    </span>
  )
}

function WalletButton() {
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, show, address }) => (
        <button type="button" onClick={show} className={isConnected ? 'btn-ghost !min-h-[40px] !px-4' : 'btn-primary !min-h-[40px] !px-4'}>
          <Wallet size={16} aria-hidden />
          {isConnected && address ? <span className="mono text-[13px]">{shortAddr(address)}</span> : <span>Connect wallet</span>}
        </button>
      )}
    </ConnectKitButton.Custom>
  )
}

const SOURCE_URL = 'https://github.com/ogeleka/ChangeBounty'

const footLink = 'inline-flex items-center gap-1.5 text-[#a9b6c9] hover:text-white'

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-white/10 text-white' : 'text-[#a9b6c9] hover:text-white'}`

export default function Layout() {
  const { data } = useAppConfig()
  return (
    <div className="app-bg min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#08111f]/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <NavLink to="/" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#85b1ed]">
            <LogoMark />
            <span className="display text-lg font-semibold">ChangeBounty</span>
          </NavLink>
          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Primary">
            <NavLink to="/dashboard" className={link}>Dashboard</NavLink>
            <NavLink to="/create" className={link}>Create job</NavLink>
            <NavLink to="/demo" className={link}>Live demo</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <NetworkBadge />
            <WalletButton />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden" aria-label="Primary mobile">
          <NavLink to="/dashboard" className={link}>Dashboard</NavLink>
          <NavLink to="/create" className={link}>Create job</NavLink>
          <NavLink to="/demo" className={link}>Live demo</NavLink>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-24 pt-8 sm:px-6 sm:pt-12">
        <Outlet />
      </main>
      <footer className="border-t border-white/10 py-12">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 text-sm sm:px-6 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <LogoMark size={24} />
              <span className="display text-base font-semibold">ChangeBounty</span>
            </div>
            <p className="mt-3 max-w-sm leading-relaxed text-[#7587a0]">
              When the internet changes, agents get paid. Verification relies on a trusted verifier service; the contract bounds what it can pay.
            </p>
          </div>
          <nav aria-label="Footer">
            <div className="label mb-3">App</div>
            <ul className="space-y-2">
              <li><NavLink to="/dashboard" className={footLink}>Dashboard</NavLink></li>
              <li><NavLink to="/create" className={footLink}>Create job</NavLink></li>
              <li><NavLink to="/demo" className={footLink}>Live demo</NavLink></li>
            </ul>
          </nav>
          <div>
            <div className="label mb-3">Verify it</div>
            <ul className="space-y-2">
              {data?.contract && (
                <li>
                  <a className={footLink} href={buildAddressExplorerUrl(data.chainId, data.contract)} target="_blank" rel="noopener noreferrer">
                    Contract <span className="mono text-[13px] text-[#9cc2ff]">{shortAddr(data.contract)}</span>
                  </a>
                </li>
              )}
              <li><a className={footLink} href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source code<ExternalLink size={13} aria-hidden /></a></li>
              <li><a className={footLink} href={`${SOURCE_URL}/blob/main/docs/SECURITY.md`} target="_blank" rel="noopener noreferrer">Security model<ExternalLink size={13} aria-hidden /></a></li>
              <li><a className={footLink} href="https://studio.arc.io/" target="_blank" rel="noopener noreferrer">Built with Arc Studio<ExternalLink size={13} aria-hidden /></a></li>
            </ul>
          </div>
        </div>
      </footer>
    </div>
  )
}
