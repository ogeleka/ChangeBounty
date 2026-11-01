/**
 * End-to-end journey on Arc TESTNET using a throwaway creator key (TEST_CREATOR_PRIVATE_KEY in .env):
 * fund a job -> baseline -> publish announcement -> agent detects -> verifier confirms -> USDC paid.
 * Requires the API server to be running (bun run server). Refuses to run against mainnet.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, isHex, parseEventLogs, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { changeBountyAbi } from '../src/contracts/changeBounty'
import { getUsdc, requireChain } from '../src/onchain-facts'
import { formatUsdc, parseUsdc } from '../src/onchain-money'
import '../server/secrets'
import type { JobView, PublicConfig } from '../server/types'

const API = process.env.API_URL ?? 'http://localhost:3001'
if (process.env.VITE_ARC_NETWORK === 'mainnet') throw new Error('e2e-testnet refuses to run against mainnet.')
const key = process.env.TEST_CREATOR_PRIVATE_KEY
if (!key || !isHex(key)) throw new Error('Set TEST_CREATOR_PRIVATE_KEY in .env (testnet throwaway key).')

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${API}${path}`, init)
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${path}: ${body.error ?? res.status}`)
  return body
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (msg: string) => console.log(`[e2e] ${msg}`)

const cfg = await api<PublicConfig>('/api/config')
if (cfg.network !== 'testnet' || !cfg.contract || !cfg.agentAddress) throw new Error('Server must be on testnet with contract + agent configured.')
const admin = process.env.DEMO_ADMIN_TOKEN
if (!admin) throw new Error('DEMO_ADMIN_TOKEN missing')

const rpc = requireChain(arcTestnet.id).rpcUrls[0]
const usdc = getUsdc(arcTestnet.id)!.address as Hex
const account = privateKeyToAccount(key)
const pub = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
const contract = cfg.contract as Hex

const reward = parseUsdc('0.01')
const funding = parseUsdc('0.03')
log(`creator ${account.address}, USDC balance ${formatUsdc(await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }))}`)

// Make sure the page has a unique headline so this run is a genuine change.
const approveTx = await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [contract, funding] })
await pub.waitForTransactionReceipt({ hash: approveTx })
log(`approved USDC: ${approveTx}`)

const createTx = await wallet.writeContract({
  address: contract,
  abi: changeBountyAbi,
  functionName: 'createJob',
  args: [cfg.demoUrl, cfg.agentAddress as Hex, reward, funding],
})
const receipt = await pub.waitForTransactionReceipt({ hash: createTx })
const jobId = parseEventLogs({ abi: changeBountyAbi, eventName: 'JobCreated', logs: receipt.logs })[0].args.jobId.toString()
log(`job #${jobId} created and funded: ${createTx}`)

await api('/api/jobs/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash: createTx }) })
for (let i = 0; i < 20; i++) {
  const j = await api<JobView>(`/api/jobs/${jobId}`)
  if (j.baseline) {
    log(`baseline established ${j.baseline.hash.slice(0, 12)}`)
    break
  }
  await sleep(1500)
}

const title = `Road closure notice ${new Date().toISOString().slice(11, 19)}`
await api('/api/demo/publish', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
  body: JSON.stringify({ title, body: 'Harbor Street will be closed to traffic on Saturday morning for the community market.' }),
})
log(`published announcement "${title}"`)

await api(`/api/jobs/${jobId}/check`, { method: 'POST' })
for (let i = 0; i < 60; i++) {
  const j = await api<JobView>(`/api/jobs/${jobId}`)
  const d = j.discoveries[0]
  if (d) log(`discovery ${d.id.slice(0, 12)} status=${d.status}${d.reason ? ` (${d.reason})` : ''}`)
  if (d?.status === 'paid' && d.txHash) {
    log(`PAID ${formatUsdc(BigInt(d.rewardRaw ?? '0'))} USDC: ${cfg.explorerBase}/tx/${d.txHash}`)
    process.exit(0)
  }
  if (d?.status === 'failed') throw new Error(`payout failed: ${d.reason}`)
  await sleep(3000)
}
throw new Error('Timed out waiting for payout.')
