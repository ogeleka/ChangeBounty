# Arc Microgrants submission

## Short description (under 120 words)

ChangeBounty turns website changes into paid work. A user funds a monitoring job with USDC on Arc and picks a fixed reward. An automated agent fetches the public page, fingerprints its text with SHA-256, and ignores the first fetch as a baseline. When the content genuinely changes, an independent verifier re-fetches the page and only then authorises the ChangeBounty contract to pay the agent, once per discovery. Creators can cancel and withdraw unused USDC. The app shows every job, discovery, balance and payout with Arc Explorer links, and a live demo changes a real public page and pays real USDC. Verification relies on a trusted service, documented and bounded by the contract.

## Why Arc

USDC is the gas token, so a one-cent bounty and its fee are both dollars-denominated and predictable. Sub-second finality makes the detect, verify, pay loop feel immediate.

## Deliverables checklist

| Item | Status / link |
| --- | --- |
| Arc Studio project URL | Fill in from your Arc Studio workspace |
| Public live application | Fill in after you deploy (Netlify, Vercel or Hugging Face; the server needs a Docker/Node host) |
| Arc mainnet contract | Fill in after you run docs/MAINNET_RUNBOOK.md |
| Real USDC payout tx and explorer link | Fill in after the mainnet demo |
| Public GitHub repository | Fill in after you push |
| Tests | Foundry: 88 passing (unit, fuzz, invariants). Server and UI helpers: 69 passing |
| README and runbook | README.md, docs/ |
| Demo video script | docs/VIDEO_SCRIPT.md |

## Testnet evidence (Arc Testnet, contract 0x5575642a6ed082bb01ec95d721af65e5a3db39fe)

Job 1 funded with 0.03 USDC, baseline captured, a real announcement published, the verifier confirmed it, and 0.01 USDC was paid by transaction 0x91ff08e625033bd965dde3d573c850ede0d100b1f795759cf36dbd2de3dedabb (https://explorer.testnet.arc.io/tx/0x91ff08e625033bd965dde3d573c850ede0d100b1f795759cf36dbd2de3dedabb).

## Honest limits

Trusted verifier (documented in docs/SECURITY.md). Single-instance JSON state, rebuilt from chain events if lost. No third-party audit yet.
