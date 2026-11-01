# Mainnet runbook

Arc Studio does not deploy to, sign for, fund, or transact on mainnet. You run these steps yourself. Arc mainnet moves real USDC and transactions are irreversible. Review every address before you send anything, and run the whole journey on Arc Testnet first.

Verified Arc mainnet details (Arc Studio registry, plus a live read of the token):

| Field | Value |
| --- | --- |
| Chain ID | 5042 |
| RPC | https://rpc.mainnet.arc.io |
| Explorer | https://explorer.arc.io |
| USDC (ERC-20, 6 decimals) | 0x3600000000000000000000000000000000000000 |
| Gas | USDC (native, 18-decimal view) |

Budget for the whole demonstration: about 0.02 USDC of escrow (one 0.01 USDC reward, 0.01 spare), about 0.05 USDC of gas in the verifier wallet, and a few cents of gas in your own wallet.

## 0. Rotate and clean up first

- Anything that was ever shown in a chat, a screenshot or a shared project export must be treated as exposed. Create NEW keys for mainnet: do not reuse any testnet key or token.
- Run `bun run check:secrets`. It must print OK.
- Secrets are never kept in the project. Locally they live in `~/.changebounty/secrets.env` (mode 600); on a host they are set as secret environment variables.

## 1. Create the mainnet verifier key and admin token

On the VPS (this is step 4 of DEPLOYMENT.md), or on a trusted machine that is not shared or screen-recorded:

```bash
sudo bash deploy/scripts/gen-keys.sh   # on the VPS
# or, locally: bun run setup:wallets
```

This prints the verifier address only. Fund it with about 0.05 USDC for gas. Read the generated `DEMO_ADMIN_TOKEN` from `~/.changebounty/secrets.env` and set both values as host secrets in step 4. Delete the local secrets file if the key will only ever live on the host.

Choose an **agent payee** address you control and that is not the verifier, so you can show the received balance. If this address is ever blocked by the USDC issuer the job cannot pay (see docs/SECURITY.md).

## 2. Deploy the contract from your wallet

Keep your deployer key in an environment variable or a keystore, never in a file in this project.

```bash
export PRIVATE_KEY=...   # your deployer key, set in your shell only
forge create contracts/ChangeBounty.sol:ChangeBounty \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --constructor-args 0x3600000000000000000000000000000000000000 <VERIFIER_ADDRESS> <YOUR_OWNER_ADDRESS>
```

A keystore (`cast wallet import`, then `--account <name>`) is safer than `--private-key`. Record both the **contract address** and the **deployment transaction hash**, and open them on https://explorer.arc.io. The owner can rotate the verifier but can never touch job funds.

## 3. Host the app with persistent storage

The official deployment is the Ubuntu VPS at https://changebounty.ogsnap.online. Follow [DEPLOYMENT.md](DEPLOYMENT.md): Docker Compose with a persistent volume, Nginx and Let's Encrypt. Static-only hosts cannot run the monitoring agent.

Set these in `/opt/changebounty/changebounty.env` on the VPS (root-only, outside the repository):

```
VITE_ARC_NETWORK=mainnet
VITE_CHANGEBOUNTY_ADDRESS=<contract address>
VITE_CHANGEBOUNTY_DEPLOY_TX=<deployment tx hash>
VITE_AGENT_ADDRESS=<agent payee address>
PUBLIC_BASE_URL=<public https origin of the app>
VERIFIER_PRIVATE_KEY=<secret>
DEMO_ADMIN_TOKEN=<secret, 24+ characters>
DATA_DIR=/data            # mount a persistent volume here if your host offers one
TRUST_PROXY=1             # when the host puts a single proxy in front
```

Leave `ALLOW_PRIVATE_FETCH_HOSTS` empty; the server refuses to start on mainnet if it is set. Without a persistent volume the server rebuilds its job list and payment history from chain events on every start (a change that happens while it is down is not detected), and demo announcements are reset.

## 4. Run the read-only preflight

With the same environment:

```bash
bun run preflight:mainnet
```

Every line must say PASS: chain 5042, official USDC, contract verifier equals the server verifier, verifier gas, public https URL reachable through the SSRF-safe fetcher. It sends nothing onchain.

## 5. Run the real USDC demonstration

1. Connect your wallet on Arc. Open **Live demo** then **Create the demo job**.
2. Reward 0.01 USDC (the minimum), fund 0.02 USDC. Approve, then create.
3. Wait for **Baseline captured**.
4. Enter the admin token and publish an announcement.
5. Watch detection, verification and payout. The last step shows the real transaction and an Arc Explorer link.
6. Record the contract address, the payout transaction hash and the explorer link. Verify the payout on https://explorer.arc.io yourself (USDC transfer to the agent address).

## 6. Clean up

Cancel and withdraw any unused escrow from the job page. If the demo was public, retire the verifier key and admin token.
