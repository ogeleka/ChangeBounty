# ChangeBounty

When the internet changes, agents get paid. ChangeBounty lets you fund a website-monitoring job with USDC on Arc. An automated agent watches a public page, and when an independent verifier confirms a real change, the contract pays the agent a fixed USDC reward.

Built with [Arc Studio](https://studio.arc.io)

## What you can do

- Create a job: connect an Arc wallet, enter a public URL, set a reward per discovery and fund it.
- Watch it run: the first fetch only sets a baseline and is never paid. Later real text changes become discoveries.
- Get paid transparently: each confirmed discovery pays once, with the transaction linked on Arc Explorer.
- Get alerts: follow a job by email or Telegram and hear when a change is detected, confirmed, paid or needs attention.
- Stay in control: cancel any time and withdraw the unused USDC.
- Try the live demo: publish an announcement on a public page and watch the full detect, verify and pay journey.

Website verification relies on a trusted verifier service. See [docs/SECURITY.md](docs/SECURITY.md).

## Tech stack

React, Vite, TypeScript, Tailwind CSS, wagmi and viem, Solidity 0.8.28 with OpenZeppelin, Foundry, and a small Bun server for the monitoring agent and verifier.

## Development

Prerequisites: Bun, Foundry.

```bash
bun install
bun run setup:wallets   # creates the verifier key and demo admin token outside the project (never printed)
bun run server          # monitoring agent, verifier and API on :3001
bun run dev             # web app on :5173 (proxies /api to the server)
```

Build and test:

```bash
bun run contracts:build
bun run contracts:test   # Foundry: unit, fuzz and invariant tests
bun run test:server      # URL safety, text extraction, redaction, id and UI helper tests
bun run build            # production web build
bun run start            # serves the API and the built web app
bun run check            # lint and typecheck
bun run check:secrets    # fails if any credential is found in project files
bun run e2e:testnet      # full fund, detect, verify, pay journey on Arc Testnet
bun run preflight:mainnet  # read-only mainnet readiness check (sends nothing)
docker compose up -d --build  # production stack (needs /opt/changebounty/changebounty.env)
```

Production runs with Docker Compose behind Nginx and Let's Encrypt on an Ubuntu VPS. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the exact commands, Cloudflare DNS steps and operations. Monitoring state lives in a persistent Docker volume; if it is lost, the app rebuilds its job list and payment history from chain events on restart.

### Environment variables

Copy `.env.example` to `.env`. Secrets are not kept in `.env`: set `VERIFIER_PRIVATE_KEY`, `DEMO_ADMIN_TOKEN`, `TELEGRAM_BOT_TOKEN` and `RESEND_API_KEY` as host secrets, or let `bun run setup:wallets` store them in `~/.changebounty/secrets.env`.

| Name | Purpose |
| --- | --- |
| `VITE_ARC_NETWORK` | `testnet` (default) or `mainnet`. |
| `VITE_CHANGEBOUNTY_ADDRESS` | Deployed ChangeBounty contract. |
| `VITE_CHANGEBOUNTY_DEPLOY_TX` | Hash of the deployment transaction, used to rebuild state safely. |
| `VITE_AGENT_ADDRESS` | Address that receives rewards. Only jobs paid to it are monitored. |
| `VERIFIER_PRIVATE_KEY` | Secret, server only. Signs payouts. Needs a little USDC for gas. |
| `DEMO_ADMIN_TOKEN` | Secret, server only. Protects the demo publish button. |
| `PUBLIC_BASE_URL` | Public origin of the deployed app, used for the demo page address. |
| `TELEGRAM_BOT_TOKEN` | Secret. Token from @BotFather. Turns on Telegram alerts. |
| `RESEND_API_KEY` | Secret. Resend API key. Turns on email alerts together with `EMAIL_FROM`. |
| `EMAIL_FROM` | Sender of alert emails, on a domain verified in Resend, for example `ChangeBounty <alerts@yourdomain>`. |
| `MAX_SUBSCRIBERS_PER_JOB` | Optional. Cap on followers per job (default 50). |
| `DATA_DIR` | Where monitoring state is stored. |
| `POLL_INTERVAL_SEC`, `VERIFY_DELAY_SEC`, `MIN_CHANGE_CHARS`, `MIN_REWARD_USDC`, `PAYOUT_COOLDOWN_SEC`, `MAX_JOBS_PER_CREATOR` | Optional tuning. |
| `ALLOW_PRIVATE_FETCH_HOSTS` | Development only. Must be empty in production. |
| `TRUST_PROXY` | Set to `1` behind a single reverse proxy so rate limits use the real client address. |
| `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` | Optional outside Arc Studio. Provisioned by Arc Studio. |
| `CHANGEBOUNTY_SECRETS_FILE` | Optional. Path of the local secrets file. |
| `TEST_CREATOR_PRIVATE_KEY` | Optional secret. Throwaway testnet key for `bun run e2e:testnet`. |

## Docs

- [Deployment guide](docs/DEPLOYMENT.md): Ubuntu VPS, Docker Compose, Nginx, HTTPS, Cloudflare.
- [Mainnet runbook](docs/MAINNET_RUNBOOK.md): deploy and run the real USDC demo yourself.
- [Security notes](docs/SECURITY.md)
- [90-second demo script](docs/VIDEO_SCRIPT.md)
- [Microgrant submission text](docs/SUBMISSION.md)
