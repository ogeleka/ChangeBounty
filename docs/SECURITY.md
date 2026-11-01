# Security notes

## Trust model (read this first)

A smart contract cannot see a website. ChangeBounty therefore relies on a **trusted verifier service** to decide whether a page really changed. The verifier holds the only key allowed to call `payDiscovery`.

What the contract enforces regardless of the verifier:

- Only the verifier address can authorise a payout.
- The reward amount and recipient are fixed when the job is created. The verifier cannot choose either.
- A discovery id can be paid once per job. Repeats revert.
- A job can only pay while Active and funded. Creators can cancel and withdraw at any time.
- Only the creator can add funds to a job. Third-party deposits revert, so nobody can send USDC they cannot get back.
- The owner can propose a new verifier, but it only becomes active 24 hours later (`VERIFIER_DELAY`). The owner must call `activateVerifier` after the delay, and can cancel a pending proposal with `cancelVerifierProposal`. The current verifier keeps paying during the delay, and creators can cancel and withdraw during that window.
- The owner cannot withdraw job funds directly and cannot renounce ownership (which would freeze verifier rotation).

**Owner power, stated precisely:** after the delay, the owner can still replace the verifier and then pay discoveries. Payouts still go only to each job's fixed agent address, so the owner cannot redirect funds, but it can release escrow early. The delay gives creators and monitors a public 24-hour window to see the proposal and react. Use a dedicated owner wallet, preferably a multisig, and never the verifier key.

If the verifier key were compromised, an attacker could pay fixed rewards from funded, active jobs to their configured agents by submitting made-up discovery ids. Loss is bounded by escrow, and creators can cancel and withdraw (subject to transaction ordering). Use small escrows until you trust the operator.

## Known limitation

If a job's agent address is later blocked by the USDC issuer, payouts to it revert and that job cannot pay. Creators can cancel and withdraw unused USDC. A pull-payment design would remove this, at the cost of an extra claim step.

## Secrets

- No private key, admin token or API token is stored in the project directory. Locally they live in `~/.changebounty/secrets.env` (mode 600, outside the project, so not in git, Docker builds or code downloads). On a host they are secret environment variables, which always take precedence.
- `.gitignore` and `.dockerignore` exclude `.env`, state data, build outputs and secrets files. `bun run check:secrets` scans the project for credential-shaped values and secrets stored in `.env`; run it before every push and deploy.
- Errors are scrubbed before they are stored or returned: URLs (RPC endpoints can carry tokens), bearer tokens, and 32-byte hex values are removed. Fetch errors are reduced to safe messages that never include internal hosts or ports.
- The browser never receives the verifier key. The admin token is typed by the operator, sent once as a bearer header and compared in constant time.
- Production refuses to start with `ALLOW_PRIVATE_FETCH_HOSTS` set, with a missing verifier key, contract or agent address on mainnet, or without a public https `PUBLIC_BASE_URL`.

## Website monitoring

- **SSRF:** only http and https on ports 80 and 443, no URL credentials, no internal hostnames, every resolved address must be public (private, loopback, link-local, CGNAT, multicast, mapped and embedded IPv6 forms are blocked), the socket is pinned to the validated address at connect time, redirects are followed manually and re-validated (max 3), responses are capped at 1.5 MB and 10 s, and only HTML or text is accepted.
- **Public exposure of monitored URLs:** job addresses are written to a public blockchain and listed in the dashboard. URLs with a #fragment, or with query parameters that look like tokens, keys, sessions or signatures, are refused, and the create form says so. Do not monitor private links.
- **Spam and abuse:** the service only monitors jobs whose agent address is its own, enforces a minimum reward, a per-wallet job limit and a global job cap, spaces payouts per job with a cooldown, and rate-limits register, check, publish and validate calls.

## Payout verification

The verifier re-fetches the page itself with a separate identity and pays only if its hash matches the agent's, differs from the baseline, the change is meaningful, the job is Active and funded, and the discovery id recomputed from chain state matches (job, baseline, new content, payouts so far). It checks `isPaid` before sending and the contract refuses repeats.

## Recovery

- The transaction hash is saved the moment a payout is broadcast. After a crash, a timeout or a restart, interrupted discoveries are settled from chain state: paid ones get their real transaction hash, unpaid ones are verified again. A payout is never sent twice.
- The job list and payment history are rebuilt from `JobCreated` and `DiscoveryPaid` events, scanned forward from a stored cursor (starting at the deployment block, never block 0). The same scan runs every cycle, so a job whose browser registration call failed is still picked up. Health is visible at `/api/health`, including blocks behind the chain head.
- State writes are atomic. An unreadable state file is set aside, not deleted.

## Not covered

DNS-based SSRF is pinned at connect time but is not a substitute for network egress controls. State is local JSON, suitable for a single instance. A change that happens while the server is fully down is not detected after recovery. The contract has unit, fuzz and invariant tests and two automated reviews, but no third-party audit. Get one before holding meaningful funds.
