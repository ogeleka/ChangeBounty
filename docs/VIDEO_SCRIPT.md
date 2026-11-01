# 90-second demonstration script

Record the Live demo page on Arc mainnet with a tiny reward. Keep the explorer tab ready.

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00-0:08 | Landing page hero | "When the internet changes, agents get paid. This is ChangeBounty, on Arc." |
| 0:08-0:20 | Create job form with the demo URL, 0.01 USDC reward, 0.03 USDC funding | "I fund a monitoring job with real USDC. One cent per confirmed discovery, three cents of escrow I can withdraw at any time." |
| 0:20-0:32 | Wallet approval, then the Create tx hash appearing | "Approve, create, done. The escrow is held by the contract, and this is the transaction on Arc Explorer." |
| 0:32-0:42 | Demo steps: Baseline captured | "The agent fetches the page once. That first fetch is only a baseline. It is never paid." |
| 0:42-0:56 | Enter admin token, click Publish; the public page on the right updates | "Now I change a real public website. Only I can publish, with a protected token." |
| 0:56-1:08 | Steps tick: Agent detects it, Verifier confirms | "The agent sees the page hash change. A separate verifier re-fetches the page itself and only signs off if it sees the same content." |
| 1:08-1:20 | Payout step with +0.01 USDC and tx link; click through to Arc Explorer | "The contract pays the agent once. Here is the real transaction on Arc Explorer, nothing simulated." |
| 1:20-1:30 | Job page: discoveries, balance, Cancel and withdraw | "Duplicates revert, the verifier can't pick the amount, and I can cancel and withdraw whatever is left. Website verification relies on a trusted verifier, and the contract bounds what it can do." |

Tips: pre-fund the wallet, pre-approve the browser wallet popup, set `POLL_INTERVAL_SEC=10` and `VERIFY_DELAY_SEC=4` so the middle of the video does not drag.
