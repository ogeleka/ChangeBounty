#!/usr/bin/env bash
# Archives the monitoring-data volume. The app can rebuild jobs and payments from chain events, but
# backups also keep baselines and demo announcements.  Usage: sudo bash deploy/scripts/backup.sh
set -euo pipefail

DEST=/var/backups/changebounty
mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker run --rm --entrypoint tar -v changebounty-data:/data:ro -v "$DEST":/backup changebounty:latest \
  czf "/backup/changebounty-data-$STAMP.tar.gz" -C /data .
chmod 600 "$DEST/changebounty-data-$STAMP.tar.gz"
find "$DEST" -name 'changebounty-data-*.tar.gz' -mtime +14 -delete
echo "Backup written: $DEST/changebounty-data-$STAMP.tar.gz"
