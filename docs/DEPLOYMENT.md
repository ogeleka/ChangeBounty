# Deploying ChangeBounty on an Ubuntu VPS (Contabo)

Target: **https://changebounty.ogsnap.online**

Architecture: Docker Compose runs one container (web app, API, monitoring agent and verifier on a single origin). Nginx on the host is the only public entry point and terminates HTTPS with a Let's Encrypt certificate that renews automatically. Monitoring data lives in a Docker volume. The container restarts on crash and on reboot.

```
Internet --> Cloudflare DNS --> VPS :443 Nginx (TLS, rate limits) --> 127.0.0.1:7860 Docker container --> /data volume
```

Nothing here deploys a contract or moves USDC. The first deployment ("Phase 1") runs the whole public site with payouts switched off. You switch on payouts yourself in "Phase 2" after you deploy the contract from your own wallet.

Replace `<VPS_IP>` and `<YOUR_EMAIL>` wherever they appear. Run commands on the VPS unless stated otherwise.

---

## 1. Cloudflare DNS (do this first, from your browser)

1. Log in to Cloudflare, choose the **ogsnap.online** zone, open **DNS > Records > Add record**.
2. Fill in:

   | Field | Value |
   | --- | --- |
   | Type | A |
   | Name | `changebounty` |
   | IPv4 address | `<VPS_IP>` (your Contabo server IP) |
   | Proxy status | **DNS only** (grey cloud) |
   | TTL | Auto |

3. Add an `AAAA` record the same way only if your VPS has an IPv6 address you have confirmed works.
4. Leave the cloud **grey** until the site works over HTTPS. A grey cloud lets Let's Encrypt reach your server directly. See section 10 if you want the orange cloud later.
5. Check it from any terminal (wait a few minutes if empty):

   ```bash
   dig +short changebounty.ogsnap.online
   ```

   The answer must be your `<VPS_IP>`.

If Contabo's customer-panel firewall is enabled, allow TCP 22, 80 and 443 there as well.

## 2. Log in and fetch the code

From your own computer:

```bash
ssh root@<VPS_IP>
```

On the server (create a normal sudo user first if you only have root, and use it from here on):

```bash
sudo mkdir -p /srv/changebounty
sudo chown "$USER":"$USER" /srv/changebounty
git clone https://github.com/ogeleka/ChangeBounty.git /srv/changebounty
cd /srv/changebounty
```

If the repository is private, authenticate first (`gh auth login`, or add a read-only deploy key) and use the SSH clone URL.

## 3. Install Docker, Nginx, Certbot and the firewall (once)

```bash
cd /srv/changebounty
sudo bash deploy/scripts/bootstrap-ubuntu.sh
```

This opens only SSH, 80 and 443 in UFW. Your SSH session stays up.

## 4. Create the settings file and secrets

```bash
cd /srv/changebounty
sudo bash deploy/scripts/gen-keys.sh
```

It creates `/opt/changebounty/changebounty.env` (root-only, mode 600), generates a **new** verifier key and demo admin token straight into it, and prints only the public verifier address. Write that address down.

The settings file lives outside the repository, so `git`, backups of the repo and Docker build contexts never contain it. Never paste its contents into a chat or a ticket.

Check the defaults, which already point at the official domain:

```bash
sudo grep -E '^(VITE_ARC_NETWORK|PUBLIC_BASE_URL|ALLOW_PRIVATE_FETCH_HOSTS)=' /opt/changebounty/changebounty.env
```

You should see `testnet`, `https://changebounty.ogsnap.online`, and an empty `ALLOW_PRIVATE_FETCH_HOSTS`.

## 5. Build and start the app

```bash
cd /srv/changebounty
sudo bash deploy/scripts/deploy.sh
```

The image build runs the secret scan and the test suite and fails if either fails. The script then starts the container and waits until it reports healthy. The log is appended to `/var/log/changebounty/deploy.log`.

Quick local check from the VPS:

```bash
curl -s http://127.0.0.1:7860/api/health
```

## 6. Install the Nginx reverse proxy

```bash
cd /srv/changebounty
sudo cp deploy/nginx/changebounty-limits.conf /etc/nginx/conf.d/changebounty-limits.conf
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/changebounty-proxy.conf /etc/nginx/snippets/changebounty-proxy.conf
sudo cp deploy/nginx/changebounty.conf /etc/nginx/sites-available/changebounty.conf
sudo ln -sf /etc/nginx/sites-available/changebounty.conf /etc/nginx/sites-enabled/changebounty.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Test over plain HTTP (the DNS record must already resolve):

```bash
curl -s http://changebounty.ogsnap.online/api/health
```

## 7. Turn on HTTPS with Let's Encrypt

```bash
sudo certbot --nginx -d changebounty.ogsnap.online -m <YOUR_EMAIL> --agree-tos --no-eff-email --redirect
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

Certbot adds the HTTPS server block and the HTTP-to-HTTPS redirect, and a systemd timer renews the certificate automatically. The dry run must say the simulated renewal succeeded.

## 8. Verify the public site

```bash
cd /srv/changebounty
bash deploy/scripts/verify-public.sh https://changebounty.ogsnap.online
```

Every line must say PASS (HTTPS, redirect, API health, config, demo page served from the public domain, SSRF guard, wrong-token rejection, no `/.env` or `/.git`, security headers, certificate expiry). Then open https://changebounty.ogsnap.online in a browser.

The monitoring agent fetches the demo page through the real public domain, so this also proves the agent can reach the site. It runs the same safe-fetch code that blocks private addresses.

## 9. Day-to-day operations

```bash
# Status and health
cd /srv/changebounty
docker compose ps
curl -s https://changebounty.ogsnap.online/api/health

# Logs
docker compose logs -f --tail=100 app            # app, agent, verifier
sudo tail -f /var/log/nginx/changebounty.access.log
sudo tail -f /var/log/nginx/changebounty.error.log
sudo tail -n 50 /var/log/changebounty/deploy.log

# Update to the latest code from GitHub and redeploy
sudo bash deploy/scripts/deploy.sh --pull

# Restart without rebuilding (also needed after editing the settings file)
sudo docker compose up -d --force-recreate

# Back up monitoring data (add to cron, see below)
sudo bash deploy/scripts/backup.sh
```

Nightly backup at 03:15:

```bash
echo '15 3 * * * root cd /srv/changebounty && bash deploy/scripts/backup.sh >> /var/log/changebounty/backup.log 2>&1' | sudo tee /etc/cron.d/changebounty-backup
```

The container uses `restart: unless-stopped`, so it comes back after a crash or a reboot. Docker is enabled at boot by the bootstrap script. If the data volume is ever lost, the app rebuilds its job list and payment history from chain events on the next start.

## 10. Optional: Cloudflare proxy (orange cloud)

Only after HTTPS works with the grey cloud.

1. Cloudflare dashboard > **SSL/TLS > Overview**: set encryption mode to **Full (strict)**. Never use "Flexible".
2. Make Nginx see real visitor addresses so per-visitor rate limits work:

   ```bash
   cd /srv/changebounty
   sudo bash deploy/scripts/update-cloudflare-ips.sh
   ```

   Re-run it every few months; Cloudflare rarely changes its ranges.
3. Switch the DNS record to **Proxied** (orange cloud).
4. In **Security > Settings**, keep Bot Fight Mode off, or add a WAF skip rule for the path `/api/demo-site/*`. Otherwise Cloudflare can challenge the monitoring agent when it fetches the demo page.
5. Re-run `bash deploy/scripts/verify-public.sh`.

## 11. Phase 2: switch on real payouts (YOU do these steps)

Do not skip the testnet journey if you have not done it. Mainnet moves real USDC and transactions are irreversible. These steps are yours; nothing in this repository sends them for you.

1. Fund the **verifier address** from step 4 with about 0.05 USDC on Arc mainnet (gas for payouts). Pick an **agent payee** wallet you control that is not the verifier.
2. From your own computer, with your own wallet, deploy the contract using the commands in [MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md#2-deploy-the-contract-from-your-wallet). Record the contract address and the deployment transaction hash.
3. Edit the settings file on the VPS:

   ```bash
   sudo nano /opt/changebounty/changebounty.env
   ```

   Set:

   ```
   VITE_ARC_NETWORK=mainnet
   VITE_CHANGEBOUNTY_ADDRESS=0x...your contract...
   VITE_CHANGEBOUNTY_DEPLOY_TX=0x...deployment tx hash...
   VITE_AGENT_ADDRESS=0x...agent payee wallet...
   ```

4. Restart and run the read-only mainnet preflight (it sends nothing):

   ```bash
   cd /srv/changebounty
   sudo docker compose up -d --force-recreate
   sleep 20
   sudo docker compose exec app bun run preflight:mainnet
   ```

   Every line must say PASS. On mainnet the server refuses to start if the contract, agent address, verifier key or public https URL is missing.
5. Run the small real-USDC demonstration from the **Live demo** page (reward 0.01 USDC, fund 0.02 USDC), following the runbook.

## 12. Troubleshooting

| Symptom | Check |
| --- | --- |
| `deploy.sh` stops at build | Read the failing line in the output: a failed test or the secret scan. Nothing is deployed. |
| Container restarting | `docker compose logs --tail=80 app`. On mainnet a clear "Unsafe configuration" list names the missing setting. |
| `502 Bad Gateway` | `docker compose ps` must show `healthy`; test `curl http://127.0.0.1:7860/api/health`. |
| Certbot fails | DNS must resolve to the VPS and be **grey cloud**; ports 80 and 443 open in UFW and the Contabo firewall. |
| Demo page never detected | `curl -s https://changebounty.ogsnap.online/api/demo-site/announcements` from the VPS; check Cloudflare bot rules (section 10). |
| Payouts say verifier not authorised | The contract's verifier must equal the verifier address from step 4. |
| Status `blocksBehind` large in `/api/health` | The chain scan is still catching up; wait, and make sure `VITE_CHANGEBOUNTY_DEPLOY_TX` is set. |

## Security checklist

- Settings file is `/opt/changebounty/changebounty.env`, mode 600, outside the repository.
- Container port is bound to `127.0.0.1` only, so Docker cannot bypass the firewall.
- The container runs as a non-root user with a read-only filesystem, no Linux capabilities and a memory limit.
- Nginx rate-limits the API and the publish button, caps request bodies at 16 KB and blocks dotfiles.
- `bun run check:secrets` and the tests gate every image build.
