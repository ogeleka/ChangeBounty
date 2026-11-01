import { describe, expect, test } from 'bun:test'
import { diffText, extractText, sha256Hex } from './extract'
import { checkUrlSyntax, FetchError, isPrivateIp, toSafeFetchError, UnsafeUrlError, validatePublicUrl } from './ssrf'
import { discoveryIdFor } from './ids'
import { redact } from './redact'
import { sanitise } from './demoSite'

describe('SSRF guard', () => {
  const blockedIps = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    'not-an-ip',
  ]
  for (const ip of blockedIps) test(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true))

  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    test(`allows public ${ip}`, () => expect(isPrivateIp(ip)).toBe(false))
  }

  const blockedUrls = [
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://localhost/',
    'http://localhost:8080/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://metadata.internal/',
    'http://intranet/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://017700000001/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://user:pass@example.com/',
    'https://example.com:8443/',
    'http://example.com:22/',
    `https://example.com/${'a'.repeat(600)}`,
    '',
    'not a url',
    'https://example.com/page#private-section',
    'https://example.com/?token=abc123',
    'https://example.com/?api_key=abc123',
    'https://example.com/?access_token=abc',
    'https://example.com/?X-Amz-Signature=abc',
    'https://example.com/?session=1',
    'https://example.com/?key=1',
  ]
  for (const u of blockedUrls) {
    test(`rejects ${u.slice(0, 50) || '(empty)'}`, () => expect(() => checkUrlSyntax(u)).toThrow(UnsafeUrlError))
  }

  test('accepts normal public URLs, including harmless query strings', () => {
    expect(checkUrlSyntax('https://example.com/news').url.host).toBe('example.com')
    expect(checkUrlSyntax('https://example.com/search?q=arc&page=2').url.search).toBe('?q=arc&page=2')
    expect(checkUrlSyntax('https://example.com/blog?keyword=usdc').url.host).toBe('example.com')
  })

  test('low-level network errors never leak internal addresses', () => {
    const leaky = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), { code: 'ECONNREFUSED' })
    const safe = toSafeFetchError(leaky)
    expect(safe).toBeInstanceOf(FetchError)
    expect(safe.message).not.toContain('10.0.0.7')
    expect(toSafeFetchError(Object.assign(new Error('getaddrinfo ENOTFOUND db.internal'), { code: 'ENOTFOUND' })).message).not.toContain('db.internal')
  })

  // Real DNS lookup: allow for a slow resolver so a deploy build does not fail on the 5 s default.
  test('rejects a private DNS result', async () => {
    await expect(validatePublicUrl('http://127.0.0.1.nip.io/')).rejects.toThrow()
  }, 20_000)
})

describe('text extraction', () => {
  const html = `<html><head><title>News</title><style>.a{}</style><script>var t=Date.now()</script></head>
  <body><nav>Home About</nav><main><h1>Big Update</h1><p>We shipped a new feature &amp; fixed bugs.</p><!-- hidden --></main>
  <footer>Copyright 2026</footer></body></html>`

  test('keeps visible text and drops scripts, styles, nav, footers', () => {
    const t = extractText(html)
    expect(t).toContain('Big Update')
    expect(t).toContain('We shipped a new feature & fixed bugs.')
    expect(t).not.toContain('Date.now')
    expect(t).not.toContain('Home About')
    expect(t).not.toContain('Copyright')
  })

  test('hash is stable for cosmetic differences and changes for content changes', () => {
    const a = sha256Hex(extractText('<p>Hello   world today</p>'))
    const b = sha256Hex(extractText('<div><p>Hello world\n today</p></div><script>1</script>'))
    const c = sha256Hex(extractText('<p>Hello world tomorrow</p>'))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  test('diff reports added and removed lines', () => {
    const d = diffText('alpha line\nbeta line', 'alpha line\ngamma line')
    expect(d.added).toEqual(['gamma line'])
    expect(d.removed).toEqual(['beta line'])
    expect(d.changedChars).toBe('gamma line'.length + 'beta line'.length)
  })
})

describe('discovery ids and sanitising', () => {
  const h1 = 'a'.repeat(64)
  const h2 = 'b'.repeat(64)
  test('ids are deterministic and sensitive to every input', () => {
    const base = discoveryIdFor(1n, h1, h2, 0)
    expect(discoveryIdFor(1n, h1, h2, 0)).toBe(base)
    expect(discoveryIdFor(2n, h1, h2, 0)).not.toBe(base)
    expect(discoveryIdFor(1n, h2, h1, 0)).not.toBe(base)
    expect(discoveryIdFor(1n, h1, h2, 1)).not.toBe(base)
  })
  test('sanitise strips control characters and caps length', () => {
    expect(sanitise('hi\u0000\u0007 there', 50)).toBe('hi there')
    expect(sanitise('x'.repeat(500), 10)).toHaveLength(10)
    expect(sanitise(42, 10)).toBe('')
  })
})

describe('redaction', () => {
  test('removes URLs with tokens, bearer tokens and key-shaped values', () => {
    const key = `0x${'ab'.repeat(32)}`
    const out = redact(`HTTP request failed. URL: https://rpc.example/api/rpc/Arc?_rpc_token=SECRET123 key ${key} Bearer abc.def-ghi`)
    expect(out).not.toContain('SECRET123')
    expect(out).not.toContain(key)
    expect(out).not.toContain('abc.def-ghi')
    expect(out).toContain('rpc.example')
  })
  test('keeps public transaction hashes when asked', () => {
    const hash = `0x${'cd'.repeat(32)}`
    expect(redact(`tx ${hash}`, true)).toContain(hash)
    expect(redact(`tx ${hash}`)).not.toContain(hash)
  })
})
