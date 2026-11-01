#!/usr/bin/env bash
# Build, start and health-check the ChangeBounty stack. Appends a timestamped log to
# /var/log/changebounty/deploy.log.   Usage:  sudo bash deploy/scripts/deploy.sh [--pull]
# The image build itself runs the secret scan and the test suite and fails if either fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CHANGEBOUNTY_ENV_FILE:-/opt/changebounty/changebounty.env}"
LOG_DIR=/var/log/changebounty
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/deploy.log") 2>&1

echo
echo "===== deploy started $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
cd "$ROOT"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE. Run deploy/scripts/gen-keys.sh first." >&2; exit 1; }
perm="$(stat -c %a "$ENV_FILE")"
[ "$perm" = "600" ] || { echo "Fix permissions: chmod 600 $ENV_FILE (is $perm)." >&2; exit 1; }
for key in VERIFIER_PRIVATE_KEY DEMO_ADMIN_TOKEN PUBLIC_BASE_URL; do
  grep -qE "^${key}=.+" "$ENV_FILE" || { echo "$key is empty in $ENV_FILE." >&2; exit 1; }
done
if git ls-files --error-unmatch .env >/dev/null 2>&1; then echo ".env is tracked by git. Refusing to deploy." >&2; exit 1; fi

if [ "${1:-}" = "--pull" ]; then
  echo "-- git pull"
  git pull --ff-only
fi
echo "-- commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

echo "-- build (runs secret scan + tests)"
docker compose build

echo "-- start"
docker compose up -d --remove-orphans

echo "-- waiting for healthy"
for i in $(seq 1 40); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' changebounty-app 2>/dev/null || echo missing)"
  if [ "$status" = "healthy" ]; then
    echo "healthy after ~$((i * 3))s"
    docker image prune -f >/dev/null
    echo "===== deploy finished OK $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
    exit 0
  fi
  sleep 3
done

echo "Container did not become healthy. Last logs:" >&2
docker compose logs --tail=80 app >&2
echo "===== deploy FAILED $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
exit 1
