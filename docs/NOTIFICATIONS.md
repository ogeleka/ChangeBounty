# Notifications plan: Telegram and email

Status: planned, not built yet.

Today a job creator has to open the dashboard to find out that a page changed. Notifications bring the discovery itself, which is what the creator paid for, to Telegram or email. They also warn the creator when a job needs attention.

## What triggers a message

| Event | Source | Sent to |
| --- | --- | --- |
| Change confirmed and paid | `DiscoveryPaid` contract event, plus the server's discovery record (added and removed text) | Job creator |
| Change rejected by the verifier | Server `rejected` job event | Job creator, if enabled |
| Job can no longer pay (balance below one reward) | Job balance and reward, read from the contract | Job creator |
| Monitoring paused (page unreachable or URL refused) | Server `paused` and `error` job events | Job creator |
| Job funded, cancelled or withdrawn | `JobFunded`, `JobCancelled`, `FundsWithdrawn` contract events | Job creator (receipt) |
| Verifier change proposed | `VerifierProposed` contract event | Every creator with an active job |

The last row supports the trust model. A new verifier can only take over 24 hours after it is proposed. That delay protects creators only if they hear about the proposal in time to cancel and withdraw.

A "change confirmed" message contains the page address, a short excerpt of the added and removed text, the reward paid and the Arc Explorer link for the payout transaction.

## How people subscribe

- **The wallet proves ownership.** On the job page, the creator signs a plain-text message with the wallet that created the job. Signing sends no transaction and costs no gas. The server only accepts the subscription if the signature comes from the job's creator, so nobody can subscribe to someone else's job or send alerts to an inbox they don't control.
- **Telegram:** "Connect Telegram" opens the ChangeBounty bot with a one-time code. Pressing Start links that chat to the wallet. `/stop` or a button on the job page unsubscribes.
- **Email:** double opt-in. Nothing is sent until the creator clicks the confirmation link. Every email has a one-click unsubscribe link.
- Subscriptions cover all of a wallet's jobs, and any job can be muted individually.

## Privacy and security

- Telegram chat IDs and email addresses are stored only on the server. They are never written to the blockchain and never returned by the public API. They are deleted on unsubscribe.
- The Telegram bot token and email-provider key are host secrets, handled like the verifier key: never in the repository, and covered by `bun run check:secrets`.
- Text from monitored pages is untrusted. It is sent as plain text, escaped and shortened. Messages link only to the ChangeBounty job page and Arc Explorer.
- Each job has a message limit per hour. Bursts of changes are combined into one summary.

## Reliability

- Alerts are driven by the same contract-event scan the server already uses to rebuild its state. Each alert is keyed by transaction hash and log index, so a restart neither loses nor repeats a message.
- Failed deliveries are retried with backoff.
- Sending happens after a payout is recorded. It can never delay or block monitoring or payouts.

## Milestones

1. **Telegram alerts:** the subscribe flow, plus alerts for paid changes, low balance, paused monitoring and verifier proposals.
2. **Email alerts:** double opt-in, unsubscribe and the same events, sent from a verified domain.
3. **Notification settings on the job page:** choose events, mute individual jobs and switch to a daily summary.
4. **Agent alerts:** reward recipients can subscribe to their own payouts.

Each milestone ships with tests and is deployed to the live app at https://changebounty.ogsnap.online.
