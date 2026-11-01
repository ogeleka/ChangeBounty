/**
 * Scrubs anything credential-shaped from text before it is stored, logged or sent to a client:
 * URLs (RPC endpoints carry tokens), 32-byte hex values (private keys), bearer tokens and token-like
 * query parameters. Public onchain hashes are 32 bytes too, so those are kept only when the caller
 * passes allowHashes.
 */
export function redact(input: string, allowHashes = false): string {
  let s = input
  s = s.replace(/\bhttps?:\/\/[^\s"')]+/gi, (url) => {
    try {
      const u = new URL(url)
      return `${u.protocol}//${u.host}/…`
    } catch {
      return '[url]'
    }
  })
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  s = s.replace(/\b(_?rpc_?token|api[_-]?key|token|secret|password)=([^\s&]+)/gi, '$1=[redacted]')
  if (!allowHashes) s = s.replace(/\b0x[0-9a-fA-F]{64}\b/g, '0x[redacted]')
  return s
}
