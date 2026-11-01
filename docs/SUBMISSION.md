# Arc Microgrants submission

## Short description (under 120 words)

ChangeBounty turns website changes into paid work. A user funds a monitoring job with USDC on Arc and picks a fixed reward. An automated agent fetches the public page, fingerprints its text with SHA-256, and ignores the first fetch as a baseline. When the content genuinely changes, an independent verifier re-fetches the page and only then authorises the ChangeBounty contract to pay the agent, once per discovery. Creators can cancel and withdraw unused USDC. The app shows every job, discovery, balance and payout with Arc Explorer links, and a live demo changes a real public page and pays real USDC. Verification relies on a trusted service, documented and bounded by the contract.

## Project description

**When the internet changes, agents get paid.**

ChangeBounty is an on-chain bounty platform for monitoring changes on public websites.

Users fund monitoring jobs with USDC and set a fixed reward per discovery. An automated agent watches the page. The first fetch only records a baseline and is never paid. When the page text really changes, a separate verifier fetches the page again to confirm the change and submits it to the ChangeBounty contract on Arc. The contract then pays the reward to the agent wallet, once per discovery. Job creators can cancel at any time and withdraw unused USDC.

**Use cases:** new tenders on a procurement portal, price or terms changes on a supplier page, a project's announcements or changelog, new job postings.

**The problem:** Important website updates are easy to miss, and traditional monitoring tools rarely offer programmable, outcome-based incentives.

**Our solution:** ChangeBounty combines automated website monitoring with transparent on-chain payments. Users pay for verified discoveries, not for monitoring activity.

**Why Arc:** On Arc, USDC is both the reward and the network fee, so neither users nor agents need a separate gas token. Every funding and payout is a public transaction on Arc Explorer.

**Technology:** Arc mainnet, Solidity, OpenZeppelin, Foundry, USDC, React, Docker, an automated monitoring agent and a verifier service.

**Live application:** https://changebounty.ogsnap.online

**Source code:** https://github.com/ogeleka/ChangeBounty

**Mainnet contract:** 0x6E5dd3CD48827bDF9C9e40edE6Ed8599b6F60A6e

**Payout proof:** Arc Testnet transaction 0x91ff08e625033bd965dde3d573c850ede0d100b1f795759cf36dbd2de3dedabb. Replace with the first Arc mainnet payout once the demo job has paid.

**Current limitation:** Verification depends on a single trusted verifier rather than a decentralized network. The contract limits what the verifier can do: it can only release a job's fixed reward from that job's balance to the agent the job creator chose, never to itself or any other address. Each discovery can be paid only once, and replacing the verifier requires a 24-hour delay.

**Roadmap:**

1. **Telegram and email alerts.** Job creators get a message when a change is confirmed and paid, when a job can no longer pay, when monitoring pauses, and when a verifier change is proposed, so they can withdraw within the 24-hour window. Creators prove they own the job by signing with their wallet. Email is double opt-in with one-click unsubscribe. Full plan: [docs/NOTIFICATIONS.md](NOTIFICATIONS.md).
2. **Watch part of a page.** Creators pick a section of the page, so ads and timestamps elsewhere never count as changes.
3. **Multiple independent verifiers.** The contract pays only after several verifiers confirm the same change.
4. **Open the agent role.** Independent agents can monitor jobs and earn the rewards. Today only ChangeBounty's own agent does.
5. **Third-party security audit** before accepting larger escrows.

## Why Arc

USDC is the gas token, so a one-cent bounty and its fee are both dollars-denominated and predictable. Sub-second finality makes the detect, verify, pay loop feel immediate.

## Deliverables checklist

| Item | Status / link |
| --- | --- |
| Arc Studio project URL | Fill in from your Arc Studio workspace |
| Public live application | https://changebounty.ogsnap.online (Arc mainnet) |
| Arc mainnet contract | [0x6E5dd3CD48827bDF9C9e40edE6Ed8599b6F60A6e](https://explorer.arc.io/address/0x6E5dd3CD48827bDF9C9e40edE6Ed8599b6F60A6e) |
| Real USDC payout tx and explorer link | Fill in after the mainnet demo job pays |
| Public GitHub repository | https://github.com/ogeleka/ChangeBounty |
| Tests | Foundry: 97 passing (93 unit and fuzz, 4 invariant). Server and UI helpers: 72 passing |
| README and runbook | README.md, docs/ |
| Demo video script | docs/VIDEO_SCRIPT.md |

## Mainnet deployment (Arc, chain 5042)

| Role | Address |
| --- | --- |
| ChangeBounty contract | 0x6E5dd3CD48827bDF9C9e40edE6Ed8599b6F60A6e |
| Verifier (only key that can call `payDiscovery`) | 0x21cC87Aa2F796755dBc1Dfd062C824e2017122Fd |
| Owner (can rotate the verifier, after a 24-hour delay) | 0x8AF54932Ad15304AFdcA549c4b72f52cd505751e |
| Agent payee | 0xAA6F4cD48aaDc424927E534cEd74DfCCB8672Fc2 |
| USDC | 0x3600000000000000000000000000000000000000 |

The deployed runtime bytecode, including the compiler metadata hash, is identical to `contracts/ChangeBounty.sol` built with this repository's `foundry.toml`.

## Testnet evidence (Arc Testnet, contract 0x5575642a6ed082bb01ec95d721af65e5a3db39fe)

Job 1 funded with 0.03 USDC, baseline captured, a real announcement published, the verifier confirmed it, and 0.01 USDC was paid by transaction 0x91ff08e625033bd965dde3d573c850ede0d100b1f795759cf36dbd2de3dedabb (https://explorer.testnet.arc.io/tx/0x91ff08e625033bd965dde3d573c850ede0d100b1f795759cf36dbd2de3dedabb).

## Honest limits

Trusted verifier (documented in docs/SECURITY.md). Single-instance JSON state, rebuilt from chain events if lost. No third-party audit yet.
