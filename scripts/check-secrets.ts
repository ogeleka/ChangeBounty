/**
 * Fails if anything that looks like a credential is present in project files that could be committed,
 * built into a Docker image or exported. Run before every push and deploy:  bun run check:secrets
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out', 'cache', 'lib', 'data', 'imported'])
const SKIP_FILES = new Set(['bun.lock', 'traces.jsonl', 'console.jsonl'])
const SKIP_EXT = /\.(png|jpe?g|gif|ico|woff2?|map|lock)$/i

// name = long hex or opaque token value
const ASSIGNMENT = /\b\w*?(PRIVATE_KEY|SECRET|ADMIN_TOKEN|BOT_TOKEN|API_KEY|ACCESS_TOKEN|MNEMONIC|SEED_PHRASE)\w*\s*[=:]\s*['"]?(0x)?[0-9a-zA-Z_\-+/]{24,}/i
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]{20,}/
const TOKEN_IN_URL = /[?&](_rpc_token|token|api_?key|access_token)=[A-Za-z0-9._~-]{12,}/i
const RAW_KEY = /\b0x[0-9a-fA-F]{64}\b/
// Telegram bot tokens look like 123456789:AAH... (bot id, colon, 35 characters).
const TELEGRAM_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/

const findings: string[] = []

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = relative(ROOT, full)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full)
      continue
    }
    if (SKIP_FILES.has(name) || SKIP_EXT.test(name) || st.size > 1_000_000) continue
    // .env is git-ignored and Docker-ignored, but must not hold secrets either (see below).
    const text = readFileSync(full, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const where = `${rel}:${i + 1}`
      if (name === '.env') {
        if (/^(VERIFIER_PRIVATE_KEY|DEMO_ADMIN_TOKEN|TEST_CREATOR_PRIVATE_KEY|TELEGRAM_BOT_TOKEN|RESEND_API_KEY)=.+/.test(line)) findings.push(`${where} secret value stored in .env (move it to the secrets file or host secrets)`)
        return
      }
      if (name === '.env.example') return
      if (ASSIGNMENT.test(line) && !/process\.env|import\.meta\.env|\$\{|<[A-Z_]+>|\.\.\.$/.test(line)) findings.push(`${where} credential-like assignment`)
      if (BEARER.test(line) && !/\$\{|\[redacted\]|`Bearer/.test(line)) findings.push(`${where} bearer token`)
      if (TOKEN_IN_URL.test(line)) findings.push(`${where} token in URL`)
      if (TELEGRAM_TOKEN.test(line)) findings.push(`${where} possible Telegram bot token`)
      // A bare 32-byte hex is also a transaction hash; only flag it next to key-ish words.
      if (RAW_KEY.test(line) && /(private|secret|mnemonic|signer|key)/i.test(line) && !/(public|hash|tx|discovery|baseline|id)/i.test(line)) findings.push(`${where} possible private key`)
    })
  }
}

walk(ROOT)

if (findings.length > 0) {
  console.error('Possible secrets found:\n' + findings.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
console.log('check:secrets OK. No credentials found in project files.')
