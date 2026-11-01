import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Secrets live OUTSIDE the project directory so they cannot end up in a git commit, a Docker build
 * context, a zip export or a code download. Real environment variables (a hosting provider's secret
 * store) always win over the file.
 */
export const SECRETS_FILE = process.env.CHANGEBOUNTY_SECRETS_FILE ?? join(homedir(), '.changebounty', 'secrets.env')

const ALLOWED = new Set(['VERIFIER_PRIVATE_KEY', 'DEMO_ADMIN_TOKEN', 'TEST_CREATOR_PRIVATE_KEY'])

export function loadSecrets(): void {
  if (!existsSync(SECRETS_FILE)) return
  try {
    if ((statSync(SECRETS_FILE).mode & 0o077) !== 0) console.warn('[secrets] secrets file is readable by other users. Run: chmod 600 on it.')
    for (const line of readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m || !ALLOWED.has(m[1]) || process.env[m[1]] !== undefined) continue
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {
    console.warn('[secrets] could not read the secrets file.')
  }
}

loadSecrets()
