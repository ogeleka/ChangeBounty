#!/usr/bin/env bash
# Creates /opt/changebounty/changebounty.env from the template and fills in the two secrets.
# Secrets are written straight to the file (mode 600) and are NEVER printed. Only the PUBLIC verifier
# address is shown. Safe to re-run: existing values are kept.
#   sudo bash deploy/scripts/gen-keys.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CHANGEBOUNTY_ENV_FILE:-/opt/changebounty/changebounty.env}"

install -d -m 0700 "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  install -m 0600 "$ROOT/deploy/changebounty.env.example" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

get() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2-; }
set_kv() {
  # Replace the first "KEY=" line without echoing the value anywhere.
  local tmp; tmp="$(mktemp)"
  awk -v k="$1" -v v="$2" 'BEGIN{done=0} $0 ~ "^"k"=" && !done {print k"="v; done=1; next} {print}' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"; chmod 600 "$ENV_FILE"
}

if [ -z "$(get VERIFIER_PRIVATE_KEY)" ]; then
  set_kv VERIFIER_PRIVATE_KEY "0x$(openssl rand -hex 32)"
  echo "Generated a new verifier key."
else
  echo "Verifier key already set. Not changed."
fi
if [ -z "$(get DEMO_ADMIN_TOKEN)" ]; then
  set_kv DEMO_ADMIN_TOKEN "$(openssl rand -hex 24)"
  echo "Generated a new demo admin token."
fi

# Derive the public verifier address inside a throwaway container (the key never touches the command line).
cd "$ROOT"
docker compose build >/dev/null
KEY="$(get VERIFIER_PRIVATE_KEY)" docker compose run --rm --no-deps -T -e KEY app \
  bun -e "import {privateKeyToAccount} from 'viem/accounts'; console.log(privateKeyToAccount(process.env.KEY).address)" \
  2>/dev/null | tail -n1 | sed 's/^/Verifier address (fund this with USDC for gas, and use it as the contract verifier): /'

echo "Settings file: $ENV_FILE (root-only). Read the demo admin token there when you need it."
