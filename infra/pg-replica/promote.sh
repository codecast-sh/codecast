#!/bin/bash
# Promote the streaming standby to primary at cutover (pl-592). Run on the host:
#   /srv/postgres/promote.sh [--dry-run] [--wait-for-lsn <lsn>]
#
# Order of operations at cutover, so no write is lost:
#   1. Stop every writer on the old primary (the Railway Convex backend).
#   2. On the old primary: select pg_current_wal_lsn();  -> pass it as --wait-for-lsn
#   3. Run this script. It waits until replay has reached that LSN, promotes,
#      drops the standby-only settings, and proves the new primary takes writes.
#   4. Point the Convex backend at this host. Then, once cutover is final,
#      drop slot pg_migrate on the old primary (it retains WAL for us forever
#      otherwise) and set the old primary default_transaction_read_only = on.
#
# Promotion is one way: the standby switches to a new timeline and cannot
# rejoin the old primary. Reverting means a fresh base backup (1 h 38 m at the
# measured 32.5 MB/s). Rehearse on a local pg_basebackup copy of the standby,
# not on the standby itself.
set -euo pipefail

CONTAINER="${CONTAINER:-postgres}"
DRY_RUN=0
WAIT_LSN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --wait-for-lsn) WAIT_LSN="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[promote] $(date -u +%FT%TZ) $*"; }
sql() { docker exec "$CONTAINER" psql -U postgres -d postgres -Atc "$1"; }

in_recovery=$(sql "select pg_is_in_recovery()")
if [ "$in_recovery" != "t" ]; then
  log "not a standby (pg_is_in_recovery = $in_recovery); nothing to promote"
  exit 1
fi

log "standby: receive $(sql 'select pg_last_wal_receive_lsn()') replay $(sql 'select pg_last_wal_replay_lsn()') lag $(sql 'select now() - pg_last_xact_replay_timestamp()') timeline $(sql 'select timeline_id from pg_control_checkpoint()')"
log "wal receiver: $(sql "select coalesce(status || ' from ' || sender_host || ' slot ' || slot_name, 'none') from pg_stat_wal_receiver")"

if [ -n "$WAIT_LSN" ]; then
  log "waiting for replay to reach $WAIT_LSN"
  for _ in $(seq 1 600); do
    if [ "$(sql "select pg_last_wal_replay_lsn() >= '$WAIT_LSN'::pg_lsn")" = "t" ]; then break; fi
    sleep 1
  done
  if [ "$(sql "select pg_last_wal_replay_lsn() >= '$WAIT_LSN'::pg_lsn")" != "t" ]; then
    log "replay never reached $WAIT_LSN (at $(sql 'select pg_last_wal_replay_lsn()')); refusing to promote with writes outstanding"
    exit 1
  fi
  log "replay reached $WAIT_LSN"
else
  log "no --wait-for-lsn given: cannot prove every write from the old primary has replayed"
fi

if [ "$(sql 'select pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()')" != "t" ]; then
  log "replay is behind receive; waiting up to 60 s"
  for _ in $(seq 1 60); do
    [ "$(sql 'select pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()')" = "t" ] && break
    sleep 1
  done
fi

if [ "$DRY_RUN" = 1 ]; then
  log "dry run: checks passed, would call pg_promote now"
  exit 0
fi

log "promoting"
if [ "$(sql 'select pg_promote(true, 120)')" != "t" ]; then
  log "pg_promote did not complete within 120 s; inspect the container log"
  exit 1
fi

# The base backup wrote primary_conninfo and primary_slot_name into
# postgresql.auto.conf. They are inert without standby.signal, but a primary
# that still names another primary is a trap for the next reader.
sql "alter system reset primary_conninfo" >/dev/null
sql "alter system reset primary_slot_name" >/dev/null
sql "select pg_reload_conf()" >/dev/null

log "new primary: in_recovery $(sql 'select pg_is_in_recovery()') timeline $(sql 'select timeline_id from pg_control_checkpoint()')"
# A real write: assigning a transaction id fails on anything but a primary.
sql "select txid_current()" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d codecast -Atc "create table if not exists _promote_probe(at timestamptz); insert into _promote_probe values (now()); drop table _promote_probe" >/dev/null
log "write probe on codecast succeeded; the host is now the primary"
log "next: point the backend here; then drop slot pg_migrate on the old primary and make it read only"
