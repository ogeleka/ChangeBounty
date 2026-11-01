#!/usr/bin/env bash
# ONLY needed if the Cloudflare DNS record is proxied (orange cloud). Makes Nginx trust Cloudflare's
# CF-Connecting-IP header so per-visitor rate limits use the real visitor address. The ranges are
# downloaded from Cloudflare, never typed by hand.   Usage: sudo bash deploy/scripts/update-cloudflare-ips.sh
set -euo pipefail

OUT=/etc/nginx/changebounty-realip.conf
TMP="$(mktemp)"
{
  echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) from https://www.cloudflare.com/ips/"
  for list in ips-v4 ips-v6; do
    curl -fsS "https://www.cloudflare.com/$list" | while read -r cidr; do
      [ -n "$cidr" ] && echo "set_real_ip_from $cidr;"
    done
  done
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive on;"
} > "$TMP"
grep -q '^set_real_ip_from' "$TMP" || { echo "Could not download Cloudflare ranges." >&2; exit 1; }
install -m 0644 "$TMP" "$OUT"
rm -f "$TMP"
nginx -t
systemctl reload nginx
echo "Installed $OUT"
