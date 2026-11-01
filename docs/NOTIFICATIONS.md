# Telegram and email alerts

Status: milestones 1 and 2 are built. Each channel is on when the server has its settings (docs/DEPLOYMENT.md section 12).

Without alerts, a job creator has to open the dashboard to find out that a page changed. Alerts bring the discovery itself, which is what the creator paid for, to Telegram or email. They also warn the creator when a job needs attention.

## What triggers an alert

| Event | Source | Status |
| --- | --- | --- |
| Change confirmed and paid | Server `paid` job event, including payments recovered from contract events | Built |
| Job paused: balance below one reward, or job cancelled | Server `paused` job event (the monitor reads the job's balance and status from the contract) | Built |
| Page refused (not a public web page) | Server `URL rejected` job event | Built |
| Page unreachable | Server `Fetch failed` job event, at most once every 6 hours per job | Built |
| Verifier change proposed | `VerifierProposed` contract event, while the proposal is still pending | Built |
| Change rejected by the verifier | Server `rejected` job event | Planned (milestone 3, opt-in) |
| Job funded or funds withdrawn (receipts) | `JobFunded`, `FundsWithdrawn` contract events | Planned (milestone 3) |

The verifier alert supports the trust model. A new verifier can only take over 24 hours after it is proposed. That delay protects creators only if they hear about the proposal in time to cancel and withdraw. Every creator with a job that isn't cancelled gets it.

A "change confirmed" alert contains the page address, up to five added and five removed lines, the reward paid and the Arc Explorer link for the payout transaction.

## How people subscribe

- **The wallet proves ownership.** On the job page, the creator signs a plain-text message with the wallet that created the job. Signing sends no transaction and costs no gas. The message names the action, the wallet, the email address (if any), the site, the chain, the time and a one-time number. The server only accepts it within 10 minutes, only once, and only from a wallet that created a monitored job. Ordinary wallets are checked locally; smart-contract wallets are checked with the chain (ERC-1271).
- **Telegram:** "Connect Telegram" gives a `t.me` link with a one-time code that works for 15 minutes. Pressing Start in Telegram links that chat to the wallet. `/status` lists linked wallets, `/stop` turns alerts off, and so does "Turn off" on the job page.
- **Email:** double opt-in. Nothing is sent until the creator confirms from the email. The confirmation and unsubscribe links open a page with a button, so mail scanners that open links cannot confirm or unsubscribe by accident. Every alert email has an unsubscribe link and a `List-Unsubscribe` header for one-click unsubscribe in mail apps.
- One Telegram chat and one email address per wallet, covering all of that wallet's jobs.

## Privacy and security

- Telegram chat IDs and email addresses are stored only in the server's state file. They are never written to the blockchain. The public API only says whether each channel is on. They are deleted on unsubscribe, and a Telegram link is removed if the person blocks the bot.
- The Telegram bot token and the Resend API key are host secrets, handled like the verifier key: never in the repository, and covered by `bun run check:secrets`. The bot token is part of Telegram request URLs, so raw network errors are never logged.
- Text from monitored pages is untrusted. Alerts are plain text. Control characters are removed and web addresses in page text are broken (`example[.]com`), so the only working links in an alert go to ChangeBounty and Arc Explorer.
- Abuse limits: at most 10 alerts per job per hour, 3 confirmation emails per address per day, 50 confirmation emails per hour in total, and per-IP rate limits on every alerts endpoint.

## Reliability

- Alerts are created from job events and saved in an outbox in the same state file, with the same atomic writes. A restart neither loses nor repeats them.
- Verifier proposals come from the contract-event scan and are recorded by transaction and log index, so rescanning never alerts twice.
- Failed deliveries are retried with backoff for about 15 minutes, then dropped and logged.
- Sending runs separately from monitoring and payouts and can never delay or block them.

## Milestones

1. **Telegram alerts.** Built.
2. **Email alerts.** Built (Resend, from a verified domain).
3. **Notification settings on the job page.** Choose events, including rejected changes and funding receipts, mute individual jobs and switch to a daily summary.
4. **Agent alerts.** Reward recipients can subscribe to their own payouts.
