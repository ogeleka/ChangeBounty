import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { config } from './config'
import { store } from './store'
import type { Announcement } from './types'

/**
 * The public demo website that the monitoring agent watches. Anyone can read the page; only the
 * holder of DEMO_ADMIN_TOKEN can publish a new announcement.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function sanitise(input: unknown, max: number): string {
  return typeof input === 'string' ? input.replace(CONTROL, '').replace(/\s+\n/g, '\n').trim().slice(0, max) : ''
}

export function tokenMatches(header: string | undefined): boolean {
  if (!config.adminToken || !header) return false
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) return false
  const a = createHash('sha256').update(m[1]).digest()
  const b = createHash('sha256').update(config.adminToken).digest()
  return timingSafeEqual(a, b)
}

export function publishAnnouncement(titleRaw: unknown, bodyRaw: unknown): Announcement {
  const title = sanitise(titleRaw, 80)
  const body = sanitise(bodyRaw, 400)
  if (title.length < 3 || body.length < 10) throw new Error('A title (3+ characters) and a message (10+ characters) are required.')
  const a: Announcement = { id: randomBytes(6).toString('hex'), title, body, publishedAt: Date.now() }
  store.addAnnouncement(a)
  return a
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** Server-rendered, script-free HTML so any crawler sees exactly what a visitor sees. */
export function renderAnnouncementsPage(): string {
  const items = store.announcements()
  const list =
    items.length === 0
      ? '<p class="empty">No announcements yet.</p>'
      : items
          .map(
            (a) => `<article><time>${esc(formatDate(a.publishedAt))}</time><h2>${esc(a.title)}</h2><p>${esc(a.body)}</p></article>`,
          )
          .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harbor Street Community Announcements</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: Georgia, 'Times New Roman', serif; background: #f6f4ee; color: #1b2433; }
  main { max-width: 640px; margin: 0 auto; padding: 56px 24px 96px; }
  h1 { font-size: 34px; letter-spacing: -0.02em; margin: 0 0 8px; }
  .lede { color: #5a6577; margin: 0 0 40px; }
  article { background: #fff; border: 1px solid #e3dfd3; border-radius: 14px; padding: 22px 24px; margin-bottom: 16px; }
  article time { font: 12px ui-monospace, Menlo, monospace; color: #7a8497; text-transform: uppercase; letter-spacing: 0.08em; }
  article h2 { font-size: 21px; margin: 8px 0 6px; }
  article p { margin: 0; line-height: 1.6; }
  .empty { color: #7a8497; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Harbor Street Announcements</h1>
    <p class="lede">Public notices from the Harbor Street neighbourhood association.</p>
  </header>
  <section id="announcements">
${list}
  </section>
</main>
</body>
</html>`
}
