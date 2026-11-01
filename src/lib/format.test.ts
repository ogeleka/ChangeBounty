import { describe, expect, test } from 'bun:test'
import { hostOf, safeHref, shortHash, timeAgo, usdc } from './format'

describe('format helpers', () => {
  test('usdc formats raw 6-decimal amounts', () => {
    expect(usdc('10000')).toBe('0.01')
    expect(usdc(1_500_000n)).toBe('1.50')
    expect(usdc('123456789')).toBe('123.456789')
    expect(usdc(undefined)).toBe('0.00')
  })
  test('shortHash keeps head and tail', () => {
    expect(shortHash(`0x${'a'.repeat(64)}`, 6, 4)).toBe('0xaaaa…aaaa')
    expect(shortHash('0x12')).toBe('0x12')
  })
  test('timeAgo buckets', () => {
    const now = 1_000_000_000
    expect(timeAgo(now - 2_000, now)).toBe('just now')
    expect(timeAgo(now - 90_000, now)).toBe('1m ago')
    expect(timeAgo(undefined, now)).toBe('never')
  })
  test('hostOf trims scheme and root path', () => {
    expect(hostOf('https://example.com/')).toBe('example.com')
    expect(hostOf('https://example.com/news')).toBe('example.com/news')
  })
  test('safeHref only allows http(s) links from untrusted chain data', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>1</script>')).toBeUndefined()
    expect(safeHref('not a url')).toBeUndefined()
  })
})
