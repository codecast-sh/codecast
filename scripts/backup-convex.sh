#!/bin/bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/.codecast/backups}"
CONVEX_DIR="$(cd "$(dirname "$0")/../packages/convex" && pwd)"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
DATE=$(date +%Y-%m-%d_%H%M)
BACKUP_FILE="$BACKUP_DIR/convex-export-$DATE.zip"

mkdir -p "$BACKUP_DIR"

echo "[$DATE] Starting Convex backup..."
cd "$CONVEX_DIR"

npx convex export --path "$BACKUP_FILE" 2>&1

if [ -f "$BACKUP_FILE" ]; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "[$DATE] Backup complete: $BACKUP_FILE ($SIZE)"
else
  echo "[$DATE] ERROR: Backup file not created" >&2
  exit 1
fi

# Rotate old backups
DELETED=$(find "$BACKUP_DIR" -name "convex-export-*.zip" -mtime +$RETENTION_DAYS -delete -print | wc -l | tr -d ' ')
if [ "$DELETED" -gt 0 ]; then
  echo "[$DATE] Cleaned up $DELETED backups older than $RETENTION_DAYS days"
fi

echo "[$DATE] Current backups:"
ls -lh "$BACKUP_DIR"/convex-export-*.zip 2>/dev/null | tail -10
