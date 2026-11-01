/**
 * Read-only readiness check for an Arc MAINNET deployment. Sends no transactions and spends nothing.
 *
 *   VITE_ARC_NETWORK=mainnet bun run preflight:mainnet
 *
 * Run it against the environment the server will actually use (host secrets set, PUBLIC_BASE_URL set).
 */
import { parseUnits } from 'viem'
import { changeBountyAbi } from '../src/contracts/changeBounty'
import { requireChain } from '../src/onchain-facts'

process.env.VITE_ARC_NETWORK ??= 'mainnet'
const results: Array<{ ok: boolean; name: string; detail: string }> = []
const check = (ok: boolean, name: string, detail = '') => results.push({ ok, name, detail })

try {
  const { config } = await import('../server/config')
  const { publicClient } = await import('../server/chain')
  const { fetchPublicPage } = await import('../server/ssrf')

  check(config.network === 'mainnet', 'Network is mainnet', config.chainName)
  check(config.chainId === 5042, 'Chain ID is 5042', String(config.chainId))
  const chainRpcId = await publicClient.getChainId()
  check(chainRpcId === 5042, 'RPC reports chain 5042', String(chainRpcId))

  check(config.contract !== null, 'Contract address configured', config.contract ?? 'missing VITE_CHANGEBOUNTY_ADDRESS')
  check(config.contractDeployTx !== null, 'Deployment transaction configured (for safe resync)', config.contractDeployTx ?? 'missing VITE_CHANGEBOUNTY_DEPLOY_TX')
  check(config.agentAddress !== null, 'Agent payee configured', config.agentAddress ?? 'missing VITE_AGENT_ADDRESS')
  check(config.verifierAddress !== null, 'Verifier key loaded', config.verifierAddress ?? 'missing VERIFIER_PRIVATE_KEY')
  check(config.allowPrivateHosts.size === 0, 'ALLOW_PRIVATE_FETCH_HOSTS is empty')
  check(config.publicBaseUrl.startsWith('https://'), 'PUBLIC_BASE_URL is https', config.publicBaseUrl)
  check(config.agentAddress?.toLowerCase() !== config.verifierAddress?.toLowerCase(), 'Agent payee differs from verifier')

  if (config.contract) {
    const code = await publicClient.getCode({ address: config.contract })
    check(Boolean(code && code !== '0x'), 'Contract has code onchain')
    if (code && code !== '0x') {
      const usdc = await publicClient.readContract({ address: config.contract, abi: changeBountyAbi, functionName: 'usdc' })
      const verifier = await publicClient.readContract({ address: config.contract, abi: changeBountyAbi, functionName: 'verifier' })
      const owner = await publicClient.readContract({ address: config.contract, abi: changeBountyAbi, functionName: 'owner' })
      check(usdc.toLowerCase() === config.usdc.toLowerCase(), 'Contract USDC is the official Arc USDC', usdc)
      check(Boolean(config.verifierAddress) && verifier.toLowerCase() === config.verifierAddress?.toLowerCase(), 'Contract verifier equals the server verifier', verifier)
      check(true, 'Contract owner (confirm this is your wallet)', owner)
    }
  }

  if (config.verifierAddress) {
    const bal = await publicClient.getBalance({ address: config.verifierAddress })
    check(bal >= parseUnits('0.02', requireChain(5042).nativeCurrency.decimals), 'Verifier has USDC for gas (at least 0.02)')
  }

  try {
    const page = await fetchPublicPage(`${config.publicBaseUrl}/api/demo-site/announcements`, 'ChangeBountyPreflight/1.0')
    check(page.html.includes('Announcements'), 'Public demo page reachable through the SSRF-safe fetcher')
  } catch (err) {
    check(false, 'Public demo page reachable through the SSRF-safe fetcher', err instanceof Error ? err.message : 'failed')
  }
} catch (err) {
  check(false, 'Configuration loads', err instanceof Error ? err.message : 'failed')
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
const failed = results.filter((r) => !r.ok).length
console.log(failed === 0 ? '\nAll checks passed. Nothing was sent onchain.' : `\n${failed} check(s) failed. Fix them before any mainnet transaction.`)
process.exit(failed === 0 ? 0 : 1)
