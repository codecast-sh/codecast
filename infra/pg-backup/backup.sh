#!/bin/bash
# Full pg_dump of the codecast Convex database, streamed directly to R2.
# Reads over Railway's private network (fast); never writes the dump to disk.
set -euo pipefail

DATE="$(date -u +%Y-%m-%d)"
KEY="backups/pg-codecast-${DATE}.dump"
S3="s3://${R2_BUCKET}/${KEY}"

# A failed pg_dump breaks the pipe mid-stream and would leave a truncated object
# that looks like a backup. Delete it so a half-dump is never mistaken for one.
cleanup_partial() { echo "[pg-backup] FAILED — removing partial ${S3}"; aws s3 rm "${S3}" --endpoint-url "${R2_ENDPOINT}" || true; }
trap cleanup_partial ERR

echo "[pg-backup] $(date -u) starting full pg_dump of codecast -> ${S3}"
START="$(date +%s)"

# -Fc custom format (restorable with pg_restore), compressed. --no-owner/-privileges
# so a restore doesn't depend on the source roles. Full dump incl Convex's own
# `indexes` table — it's a regular table here, and Convex needs it to be a faithful,
# restorable snapshot. Streams to R2 via a multipart upload from stdin.
pg_dump -Fc -Z6 --no-owner --no-privileges "${DATABASE_URL}" \
  | aws s3 cp - "${S3}" --endpoint-url "${R2_ENDPOINT}" --expected-size 120000000000

trap - ERR
ELAPSED="$(( $(date +%s) - START ))"
echo "[pg-backup] uploaded in ${ELAPSED}s:"
aws s3 ls "${S3}" --endpoint-url "${R2_ENDPOINT}"

# Rotate: drop pg-codecast-*.dump older than 14 days. Scoped to this prefix only —
# never touches the old convex-*.zip backups or the preserved backups-archive/.
CUTOFF="$(date -u -d '14 days ago' +%Y-%m-%d)"
aws s3 ls "s3://${R2_BUCKET}/backups/" --endpoint-url "${R2_ENDPOINT}" | awk '{print $4}' | while read -r f; do
  case "${f}" in
    pg-codecast-*.dump)
      d="${f#pg-codecast-}"; d="${d%.dump}"
      if [ "${d}" \< "${CUTOFF}" ]; then
        aws s3 rm "s3://${R2_BUCKET}/backups/${f}" --endpoint-url "${R2_ENDPOINT}" && echo "[pg-backup] rotated ${f}"
      fi ;;
  esac
done

echo "[pg-backup] complete"
