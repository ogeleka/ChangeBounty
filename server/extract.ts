import { createHash } from 'node:crypto'

const MAX_TEXT = 60_000

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  copy: '(c)',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' '
      try {
        return String.fromCodePoint(code)
      } catch {
        return ' '
      }
    }
    return NAMED[body.toLowerCase()] ?? match
  })
}

/**
 * Reduce an HTML page to its meaningful text: one visible line per block, with scripts, styles,
 * navigation, footers and markup removed. Lines without real words (counters, separators) are dropped
 * so cosmetic noise does not register as a change.
 */
export function extractText(html: string): string {
  let s = html.slice(0, 2_000_000)
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|template|svg|iframe|nav|footer|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  // Source line wrapping is not content: collapse it before block elements introduce real line breaks.
  s = s.replace(/[\s\u00a0]+/g, ' ')
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  s = s.replace(/<\/?(p|div|section|article|main|aside|header|li|ul|ol|tr|table|h[1-6]|br|hr|blockquote|pre|form|details|summary|dd|dt)\b[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  const lines: string[] = []
  if (title) lines.push(decodeEntities(title.replace(/<[^>]+>/g, ' ')))
  for (const raw of s.split(/\n+/)) {
    const line = raw.replace(/[\s\u00a0]+/g, ' ').trim()
    if (!line) continue
    if ((line.match(/\p{L}/gu) ?? []).length < 3) continue
    if (/^(\(c\)|copyright)\b/i.test(line)) continue
    lines.push(line)
  }
  return lines.join('\n').slice(0, MAX_TEXT)
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface TextDiff {
  added: string[]
  removed: string[]
  changedChars: number
}

/** Line-level multiset diff between two extracted texts. */
export function diffText(before: string, after: string): TextDiff {
  const counts = new Map<string, number>()
  for (const l of before ? before.split('\n') : []) counts.set(l, (counts.get(l) ?? 0) + 1)
  const added: string[] = []
  for (const l of after ? after.split('\n') : []) {
    const c = counts.get(l) ?? 0
    if (c > 0) counts.set(l, c - 1)
    else added.push(l)
  }
  const removed: string[] = []
  for (const [l, c] of counts) for (let i = 0; i < c; i++) removed.push(l)
  const changedChars = [...added, ...removed].reduce((n, l) => n + l.length, 0)
  return { added, removed, changedChars }
}
