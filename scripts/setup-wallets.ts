/**
 * Generates the server-side verifier key and a demo admin token.
 *
 * Secrets are written to a file OUTSIDE the project (default ~/.changebounty/secrets.env, mode 0600), so
 * they never end up in git, a Docker build or a code download. They are NEVER printed. The public
 * agent address, if requested, goes into .env.
 *
 *   bun run setup:wallets            # verifier key + admin token (skips anything already set)
 *   bun run setup:wallets --agent    # also creates a throwaway agent payee address (testnet only)
 *
 * In production, set VERIFIER_PRIVATE_KEY and DEMO_ADMIN_TOKEN as host secrets instead.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { SECRETS_FILE } from '../server/secrets'

const ENV = '.env'
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const has = (text: string, name: string) => new RegExp(`^${name}=.+`, 'm').test(text) || Boolean(process.env[name])

const secrets = read(SECRETS_FILE)
const secretLines: string[] = []

if (!has(secrets, 'VERIFIER_PRIVATE_KEY')) {
  const key = generatePrivateKey()
  secretLines.push(`VERIFIER_PRIVATE_KEY=${key}`)
  console.log('Verifier address (fund with a little USDC for gas):', privateKeyToAccount(key).address)
} else {
  console.log('VERIFIER_PRIVATE_KEY already set. Not changed.')
}
if (!has(secrets, 'DEMO_ADMIN_TOKEN')) {
  secretLines.push(`DEMO_ADMIN_TOKEN=${randomBytes(24).toString('hex')}`)
  console.log(`DEMO_ADMIN_TOKEN created in ${SECRETS_FILE}`)
}

if (secretLines.length > 0) {
  mkdirSync(dirname(SECRETS_FILE), { recursive: true, mode: 0o700 })
  appendFileSync(SECRETS_FILE, `${secrets === '' || secrets.endsWith('\n') ? '' : '\n'}${secretLines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(SECRETS_FILE, 0o600)
}

if (process.argv.includes('--agent') && !has(read(ENV), 'VITE_AGENT_ADDRESS')) {
  // The key is discarded on purpose: this is a throwaway testnet payee. On mainnet use your own address.
  const agent = privateKeyToAccount(generatePrivateKey()).address
  const env = read(ENV)
  appendFileSync(ENV, `${env === '' || env.endsWith('\n') ? '' : '\n'}VITE_AGENT_ADDRESS=${agent}\n`)
  console.log('Throwaway testnet agent payee:', agent)
}
