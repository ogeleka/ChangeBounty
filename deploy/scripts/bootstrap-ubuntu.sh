#!/usr/bin/env bash
# One-time server preparation for Ubuntu 22.04 / 24.04. Run as a sudo-capable user:
#   sudo bash deploy/scripts/bootstrap-ubuntu.sh
# Installs Docker Engine + Compose, Nginx, Certbot, UFW and fail2ban, and opens only SSH, 80 and 443.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi
. /etc/os-release
if [ "${ID}" != "ubuntu" ]; then echo "This script targets Ubuntu (found ${ID})." >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg ufw nginx certbot python3-certbot-nginx fail2ban openssl

# Docker Engine and the Compose plugin from Docker's official apt repository.
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker nginx fail2ban

# Firewall: SSH must stay reachable, so allow it BEFORE enabling.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Directories for settings (root-only) and logs.
install -d -m 0700 /opt/changebounty
install -d -m 0750 /var/log/changebounty
install -d -m 0750 /var/backups/changebounty

echo
echo "Bootstrap complete."
docker --version
docker compose version
nginx -v
certbot --version
