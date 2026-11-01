import './secrets'
import { isAddress, isHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import { getUsdc, requireChain } from '../src/onchain-facts'
import { parseUsdc } from '../src/onchain-money'

const env = process.env

export type Network = 'testnet' | 'mainnet'

const network: Network = env.VITE_ARC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
const chainDef = network === 'mainnet' ? arc : arcTestnet
const chainFact = requireChain(chainDef.id)
const usdcFact = getUsdc(chainDef.id)
if (!usdcFact) throw new Error(`USDC is not registered for chain ${chainDef.id}`)

function addr(value: string | undefined): Address | null {
  return value && isAddress(value) ? value : null
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(env[name])
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback
}

function txEnv(value: string | undefined): Hex | null {
  return value && isHex(value) && value.length === 66 ? value : null
}

function minReward(): bigint {
  try {
    const v = parseUsdc(env.MIN_REWARD_USDC ?? '0.01')
    return v > 0n ? v : 10_000n
  } catch {
    return 10_000n
  }
}

/** The RPC proxy provisioned by Arc Studio is used when present, else the public RPC from the registry. */
function resolveRpcUrl(): string {
  const key = network === 'mainnet' ? 'Arc' : 'Arc_Testnet'
  const chains = (env.RPC_PROXY_CHAINS ?? '').split(',')
  if (env.RPC_PROXY_BASE_URL && env.RPC_PROXY_TOKEN && chains.includes(key)) {
    return `${env.RPC_PROXY_BASE_URL}/api/rpc/${key}?_rpc_token=${env.RPC_PROXY_TOKEN}`
  }
  return chainFact.rpcUrls[0]
}

function loadVerifierKey(): Hex | null {
  const raw = env.VERIFIER_PRIVATE_KEY
  if (!raw) return null
  const key = raw.startsWith('0x') ? raw : `0x${raw}`
  return isHex(key) && key.length === 66 ? key : null
}

const verifierKey = loadVerifierKey()
const port = intEnv('PORT', 3001, 1, 65535)
const allowPrivateHosts = new Set(
  (env.ALLOW_PRIVATE_FETCH_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)
const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')
const contract = addr(env.VITE_CHANGEBOUNTY_ADDRESS)
const agentAddress = addr(env.VITE_AGENT_ADDRESS)
const production = network === 'mainnet' || env.NODE_ENV === 'production'

/** Misconfiguration that would be unsafe or silently broken in production fails fast at startup. */
function assertProductionSafe(): void {
  const problems: string[] = []
  if (allowPrivateHosts.size > 0) problems.push('ALLOW_PRIVATE_FETCH_HOSTS must be empty in production (it disables SSRF protection).')
  if (network === 'mainnet') {
    if (!contract) problems.push('VITE_CHANGEBOUNTY_ADDRESS is required on mainnet.')
    if (!agentAddress) problems.push('VITE_AGENT_ADDRESS is required on mainnet.')
    if (!verifierKey) problems.push('VERIFIER_PRIVATE_KEY is required on mainnet (set it as a host secret, not in a file in the project).')
    if (!/^https:\/\/[^/]+/i.test(publicBaseUrl) || /localhost|127\.0\.0\.1/.test(publicBaseUrl)) problems.push('PUBLIC_BASE_URL must be the public https origin on mainnet.')
    if (env.DEMO_ADMIN_TOKEN && env.DEMO_ADMIN_TOKEN.length < 24) problems.push('DEMO_ADMIN_TOKEN must be at least 24 characters on mainnet.')
  }
  if (problems.length > 0) throw new Error(`Unsafe configuration:\n- ${problems.join('\n- ')}`)
}
if (production) assertProductionSafe()

export const config = {
  port,
  network,
  production,
  chain: chainDef,
  chainId: chainDef.id as number,
  chainName: chainFact.name,
  explorerBase: chainFact.explorerBase,
  rpcUrl: resolveRpcUrl(),
  usdc: usdcFact.address as Address,
  contract,
  contractDeployTx: txEnv(env.VITE_CHANGEBOUNTY_DEPLOY_TX),
  agentAddress,
  /** Server-side only. Never serialised into any response. */
  verifierKey,
  verifierAddress: verifierKey ? privateKeyToAccount(verifierKey).address : null,
  adminToken: env.DEMO_ADMIN_TOKEN && env.DEMO_ADMIN_TOKEN.length >= 16 ? env.DEMO_ADMIN_TOKEN : null,
  publicBaseUrl,
  pollIntervalMs: intEnv('POLL_INTERVAL_SEC', 30, 5, 3600) * 1000,
  verifyDelayMs: intEnv('VERIFY_DELAY_SEC', 6, 1, 300) * 1000,
  payoutCooldownMs: intEnv('PAYOUT_COOLDOWN_SEC', 30, 0, 3600) * 1000,
  minChangeChars: intEnv('MIN_CHANGE_CHARS', 24, 1, 10_000),
  minRewardRaw: minReward(),
  maxJobsPerCreator: intEnv('MAX_JOBS_PER_CREATOR', 5, 1, 100),
  dataDir: env.DATA_DIR ?? 'server/data',
  /** Development only: explicit host:port pairs the fetcher may reach even if private. Refused in production. */
  allowPrivateHosts,
}
