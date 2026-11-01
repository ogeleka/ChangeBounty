/** Types shared between the server and the browser app (type-only imports). */

export type JobEventType =
  | 'registered'
  | 'baseline'
  | 'check'
  | 'change_detected'
  | 'minor_change'
  | 'verifying'
  | 'verified'
  | 'rejected'
  | 'paid'
  | 'paused'
  | 'error'

export interface JobEvent {
  t: number
  type: JobEventType
  message: string
  txHash?: string
  discoveryId?: string
}

export interface PageSnapshot {
  hash: string
  /** Normalised text, capped. Kept so a later change can be summarised. */
  text: string
  at: number
}

export type DiscoveryStatus = 'detected' | 'verifying' | 'verified' | 'paid' | 'rejected' | 'failed'

export interface Discovery {
  id: string
  jobId: string
  baselineHash: string
  newHash: string
  detectedAt: number
  added: string[]
  removed: string[]
  status: DiscoveryStatus
  reason?: string
  attempts?: number
  /** Hash of the payout transaction as soon as it is broadcast, so a restart can recover it. */
  pendingTx?: string
  verifiedAt?: number
  verifierHash?: string
  paidAt?: number
  txHash?: string
  blockNumber?: string
  rewardRaw?: string
}

export type MonitoringState = 'active' | 'paused' | 'invalid_url' | 'rejected'

export interface MonitoredJob {
  id: string
  creator: string
  agent: string
  url: string
  urlHash: string
  rewardRaw: string
  createTxHash: string
  createBlock?: string
  registeredAt: number
  monitoring: MonitoringState
  monitoringReason?: string
  baseline?: PageSnapshot
  lastCheckAt?: number
  lastCheckOk?: boolean
  lastError?: string
  checks: number
  events: JobEvent[]
}

export interface ChainJobView {
  status: 'Active' | 'Cancelled'
  balanceRaw: string
  payouts: number
}

export interface JobView extends MonitoredJob {
  chain?: ChainJobView
  discoveries: Discovery[]
}

export interface Announcement {
  id: string
  title: string
  body: string
  publishedAt: number
}

export interface PublicConfig {
  network: 'testnet' | 'mainnet'
  chainId: number
  chainName: string
  explorerBase: string
  usdc: string
  contract: string | null
  agentAddress: string | null
  verifierAddress: string | null
  demoUrl: string
  pollIntervalSec: number
  demoPublishEnabled: boolean
  verifierReady: boolean
  minRewardRaw: string
  /** Which alert channels this server offers. `site` is signed into alert requests. */
  alerts: { telegramBot: string | null; email: boolean; site: string }
}

/** Alert subscriptions for one wallet. Booleans only: chat ids and email addresses are never returned. */
export interface AlertStatus {
  telegram: boolean
  email: 'none' | 'pending' | 'confirmed'
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'disabled'
  cursorBlock?: string
  headBlock?: string
  blocksBehind?: string
  lastError?: string
  lastRunAt?: number
}
