import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import type { Readable } from 'node:stream'
import { config } from './config'

/**
 * SSRF-safe fetching of public web pages.
 *
 * Layers: scheme and port allow-list, no credentials in URLs, hostname deny-list, every resolved
 * address must be public, the socket is pinned to the validated address (so DNS cannot change between
 * check and connect), redirects are followed manually and re-validated, and size, time and
 * content-type are capped.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

/** An error whose message is safe to show to users and store: it never contains internal addresses or stack details. */
export class FetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchError'
  }
}

/** Collapse any low-level network error into a message that cannot leak internal hosts, IPs or ports. */
export function toSafeFetchError(err: unknown): UnsafeUrlError | FetchError {
  if (err instanceof UnsafeUrlError || err instanceof FetchError) return err
  const code = (err as { code?: string } | null)?.code ?? ''
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return new FetchError('The hostname could not be resolved.')
  if (/CERT|TLS|SSL|DEPTH_ZERO|UNABLE_TO_VERIFY/.test(code)) return new FetchError('The site presented an invalid TLS certificate.')
  if (/TIMEDOUT/.test(code)) return new FetchError('Timed out fetching the page.')
  return new FetchError('The site could not be reached.')
}

export const MAX_URL_LENGTH = 512

// Job addresses are written to a public blockchain forever, so anything credential-shaped is refused.
const SENSITIVE_PARAM = /(token|secret|passw|passwd|pwd|apikey|api[-_]?key|auth|credential|signature|session|jwt|bearer)|^(key|sig|sid|code|otp|pin|access|private)$/i
const MAX_BYTES = 1_500_000
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const ALLOWED_PORTS = new Set(['', '80', '443'])
const ALLOWED_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain']

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits)
    const start = ipv4ToInt(base)
    return n >= start && n < start + size
  })
}

function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase()
  const zone = addr.indexOf('%')
  if (zone !== -1) addr = addr.slice(0, zone)
  // Embedded dotted IPv4 tail, e.g. ::ffff:127.0.0.1
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr)
  if (tail) {
    const v4 = tail[1].split('.').map(Number)
    if (v4.some((p) => p > 255)) return null
    addr = addr.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16)
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (groups.length !== 8) return null
  const out = groups.map((g) => parseInt(g, 16))
  return out.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : out
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** True when the address is anything other than a public unicast address. Unparseable input is treated as private. */
export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return isPrivateV4(ip)
  if (family !== 6) return true
  const g = expandV6(ip)
  if (!g) return true
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (allZeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return true // :: and ::1
  if (allZeroUpTo(5) && g[5] === 0xffff) return isPrivateV4(v4FromGroups(g[6], g[7])) // v4-mapped
  if (allZeroUpTo(6)) return true // deprecated v4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return true // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true // link local
  if ((g[0] & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true // teredo, documentation
  if (g[0] === 0x2002) return true // 6to4 embeds arbitrary IPv4
  if ((g[0] & 0xe000) !== 0x2000) return true // only global unicast 2000::/3 is allowed
  return false
}

function isAllowlisted(host: string, port: string, protocol: string): boolean {
  const effective = port || (protocol === 'https:' ? '443' : '80')
  return config.allowPrivateHosts.has(`${host}:${effective}`)
}

export interface ValidatedUrl {
  url: URL
  allowlisted: boolean
}

/** Synchronous syntax and policy checks. Throws UnsafeUrlError. */
export function checkUrlSyntax(raw: string): ValidatedUrl {
  if (typeof raw !== 'string' || raw.length === 0) throw new UnsafeUrlError('Enter a website address.')
  if (raw.length > MAX_URL_LENGTH) throw new UnsafeUrlError(`URL is longer than ${MAX_URL_LENGTH} characters.`)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new UnsafeUrlError('That is not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError('Only http and https URLs are allowed.')
  if (url.username || url.password) throw new UnsafeUrlError('URLs with embedded credentials are not allowed.')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new UnsafeUrlError('URL has no host.')
  const allowlisted = isAllowlisted(host, url.port, url.protocol)
  if (!allowlisted) {
    if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError('Only the standard web ports 80 and 443 are allowed.')
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.lan') ||
      host.endsWith('.home.arpa') ||
      (!host.includes('.') && net.isIP(host) === 0)
    ) {
      throw new UnsafeUrlError('Internal hostnames are not allowed.')
    }
    if (net.isIP(host) !== 0 && isPrivateIp(host)) throw new UnsafeUrlError('Private and reserved IP addresses are not allowed.')
  }
  if (url.hash) throw new UnsafeUrlError('Remove the #fragment. Job addresses are public onchain.')
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_PARAM.test(name)) throw new UnsafeUrlError('Remove secrets (tokens, keys, sessions) from the URL. Job addresses are public onchain.')
  }
  return { url, allowlisted }
}

async function resolvePublic(host: string, allowlisted: boolean): Promise<LookupAddress[]> {
  const bare = host.replace(/^\[|\]$/g, '')
  if (net.isIP(bare) !== 0) return [{ address: bare, family: net.isIP(bare) }]
  let addrs: LookupAddress[]
  try {
    addrs = await dnsLookup(bare, { all: true, verbatim: true })
  } catch {
    throw new UnsafeUrlError('Could not resolve that hostname.')
  }
  if (addrs.length === 0) throw new UnsafeUrlError('Could not resolve that hostname.')
  if (!allowlisted && addrs.some((a) => isPrivateIp(a.address))) {
    throw new UnsafeUrlError('That hostname resolves to a private or reserved address.')
  }
  return addrs
}

/** Full validation including DNS. Returns the parsed URL when it is safe to fetch. */
export async function validatePublicUrl(raw: string): Promise<URL> {
  const { url, allowlisted } = checkUrlSyntax(raw)
  await resolvePublic(url.hostname, allowlisted)
  return url
}

export interface FetchedPage {
  finalUrl: string
  status: number
  contentType: string
  html: string
}

function decoderFor(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  const opts = { maxOutputLength: MAX_BYTES + 1 }
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(opts)
    case 'deflate':
      return zlib.createInflate(opts)
    case 'br':
      return zlib.createBrotliDecompress(opts)
    default:
      return null
  }
}

async function requestOnce(url: URL, userAgent: string, allowlisted: boolean): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  // Resolve and validate once. Every address returned has passed the public-address check.
  const pinned = (await resolvePublic(url.hostname, allowlisted))[0]
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'accept-encoding': 'gzip, deflate, br' },
        // Pin the socket to the address validated above: no DNS rebinding window.
        // For HTTPS, Bun's node:https ignores a custom lookup and verifies the certificate against the IP,
        // so the TLS socket is connected to the validated IP while SNI and certificate checks keep the hostname.
        ...(url.protocol === 'https:'
          ? {
              createConnection: () =>
                tls.connect({
                  socket: net.connect(Number(url.port) || 443, pinned.address),
                  servername: url.hostname,
                  host: url.hostname,
                  port: Number(url.port) || 443,
                }),
            }
          : {
              lookup: ((_hostname: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
                if (opts.all) cb(null, [pinned])
                else cb(null, pinned.address, pinned.family)
              }) as unknown as NonNullable<https.RequestOptions['lookup']>,
            }),
      },
      (res) => {
        const status = res.statusCode ?? 0
        const type = String(res.headers['content-type'] ?? '').toLowerCase()
        if (status >= 300 && status < 400) {
          res.resume()
          done(() => resolve({ status, headers: res.headers, body: '' }))
          return
        }
        if (!ALLOWED_TYPES.some((t) => type.startsWith(t))) {
          res.destroy()
          done(() => reject(new FetchError('The page is not HTML or plain text.')))
          return
        }
        const decoder = decoderFor(res.headers['content-encoding'])
        const stream: Readable = decoder ? res.pipe(decoder) : res
        const chunks: Buffer[] = []
        let total = 0
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_BYTES) {
            req.destroy()
            done(() => reject(new FetchError('The page is too large to monitor.')))
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', () => done(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })))
        stream.on('error', () => done(() => reject(new FetchError('The page could not be read.'))))
      },
    )
    const timer = setTimeout(() => {
      req.destroy()
      done(() => reject(new FetchError('Timed out fetching the page.')))
    }, TIMEOUT_MS)
    req.on('error', (err) => done(() => reject(toSafeFetchError(err))))
    req.end()
  })
}

/** Fetch a public page. Throws UnsafeUrlError for disallowed targets and FetchError (safe message) for anything else. */
export async function fetchPublicPage(raw: string, userAgent: string): Promise<FetchedPage> {
  try {
    let current = raw
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { url, allowlisted } = checkUrlSyntax(current)
      await resolvePublic(url.hostname, allowlisted)
      const res = await requestOnce(url, userAgent, allowlisted)
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.location
        if (!location) throw new FetchError('The site sent a redirect without a destination.')
        current = new URL(location, url).toString()
        continue
      }
      if (res.status < 200 || res.status >= 300) throw new FetchError(`The page returned HTTP ${res.status}.`)
      return {
        finalUrl: url.toString(),
        status: res.status,
        contentType: String(res.headers['content-type'] ?? ''),
        html: res.body,
      }
    }
    throw new FetchError('The site redirected too many times.')
  } catch (err) {
    throw toSafeFetchError(err)
  }
}
