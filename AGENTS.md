# ChangeBounty

> Built with Arc Studio

Project memory for future agents.

## What this app does

ChangeBounty: users fund website-monitoring jobs with USDC on Arc. An agent hashes the page text, the first fetch is an unpaid baseline, a separate verifier re-fetches to confirm a change, and the contract pays a fixed reward once per discovery. Tagline: "When the internet changes, agents get paid."

## Tech stack

- Frontend: React 18, Vite, TypeScript, Tailwind, react-router-dom, wagmi v2, viem, ConnectKit, framer-motion.
- Server: Bun + node:http in `server/` (SSRF-safe fetcher, monitor, verifier, API, Telegram and email alerts in `alerts.ts`/`alertText.ts`). Vite proxies `/api` to :3001. Run with `bun run server`.
- Contracts: `contracts/ChangeBounty.sol` (OpenZeppelin 5.6.1, Solidity 0.8.28). Tests in `contracts/test/ChangeBounty.t.sol` (97 passing: 93 unit and fuzz, 4 invariant). Server tests: `bun run test:server` (83 passing).

## Deployments

- Arc Testnet (5042002): ChangeBounty `0x5575642a6ed082bb01ec95d721af65e5a3db39fe` (deploy tx `0x2e3a20d98020d749c7f71f5cf42854467959c1bcaf3cc5bf086a3bd7ac4c7db3`; the older `0x8cbef3fc…` is superseded: fundJob was made creator-only), verifier `0x4A33CFbf0c0a7C27B6EF0b5eEcBdD17D783c0bca`, owner = platform deployer.
- Arc mainnet (5042): ChangeBounty `0x6E5dd3CD48827bDF9C9e40edE6Ed8599b6F60A6e`, deployed by the user from their own wallet (docs/MAINNET_RUNBOOK.md). Verifier `0x21cC87Aa2F796755dBc1Dfd062C824e2017122Fd`, owner `0x8AF54932Ad15304AFdcA549c4b72f52cd505751e`, agent payee `0xAA6F4cD48aaDc424927E534cEd74DfCCB8672Fc2`. Its runtime bytecode (including the metadata hash) matches `contracts/ChangeBounty.sol` built with this repo's `foundry.toml`.
- Testnet payout proof: tx `0x91ff08e625033bd965dde3d573c850ede0d100b1f795759cf36dbd2de3dedabb`.

## Production

- Official URL: https://changebounty.ogsnap.online on an Ubuntu VPS, running Arc mainnet. Docker Compose (`docker-compose.yml`) runs the app; host Nginx + Certbot terminate HTTPS. Settings and secrets live in `/opt/changebounty/changebounty.env` on the server (never in the repo). Guide: docs/DEPLOYMENT.md; helper scripts in `deploy/scripts/`.
- Hugging Face Docker Spaces require a PRO plan, so they are not used.

## Rules for editing

- Network and addresses come from `.env` (`VITE_ARC_NETWORK`, `VITE_CHANGEBOUNTY_ADDRESS`, `VITE_AGENT_ADDRESS`) via `/api/config`; chain and USDC facts come from `@/onchain-facts`.
- Secrets (`VERIFIER_PRIVATE_KEY`, `DEMO_ADMIN_TOKEN`, `TEST_CREATOR_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY`) live in `~/.changebounty/secrets.env` or host secrets, never in `.env` or the project. Never print them. Run `bun run check:secrets` before pushing or deploying.
- Mainnet is never deployed or transacted by Arc Studio; the user does it (docs/MAINNET_RUNBOOK.md).
- `ALLOW_PRIVATE_FETCH_HOSTS=localhost:3001` is sandbox-only so the agent can fetch the local demo page. Leave empty in production.
- Do not weaken `server/ssrf.ts`; every fetch of a monitored page goes through it. Alerts only call the fixed Telegram and Resend API hosts (`server/telegram.ts`, `server/email.ts`).
- Known limitation: a USDC-blocked agent address cannot be paid (documented in docs/SECURITY.md).
- Alerts: subscriptions need a wallet signature built by `src/lib/alertMessage.ts` (shared by app and server; change both sides together). Chat ids and emails never leave the server. Page text in alerts goes through `inertText`. See docs/NOTIFICATIONS.md.

## To run

```bash
bun install
bun run setup:wallets
bun run server
bun run dev
```
