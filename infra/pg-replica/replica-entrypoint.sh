#!/bin/bash
# First boot on an empty volume: take a streaming base backup of the primary
# and configure this data directory as a hot standby. Every later boot: the
# data directory already exists, so fall straight through to the template's
# wrapper.sh, which starts postgres (standby.signal keeps it in recovery).
set -euo pipefail

: "${PGDATA:=/var/lib/postgresql/data/pgdata}"
: "${PRIMARY_HOST:?PRIMARY_HOST is required (e.g. postgres.railway.internal)}"
: "${PRIMARY_PORT:=5432}"
: "${REPLICATION_USER:=replicator}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is required}"
: "${REPLICATION_SLOT:=pg_replica_backup}"
export PGDATA

log() { echo "[pg-replica] $(date -u +%FT%TZ) $*"; }

# pg_basebackup writes PG_VERSION early, so its presence alone does not mean the
# copy finished. The marker is written only after a complete base backup; a data
# directory without it is a failed attempt and is wiped and redone.
MARKER="$PGDATA/.pg-replica-bootstrapped"
if [ -s "$PGDATA/PG_VERSION" ] && [ ! -f "$MARKER" ]; then
  log "data directory exists but the base backup never completed; wiping it and starting over"
  find "$PGDATA" -mindepth 1 -delete
fi

if [ ! -f "$MARKER" ]; then
  # The base backup reads the whole primary once (same IO cost as one dump).
  # BOOTSTRAP_AFTER lets the service be deployed now and take that read at a
  # quiet hour.
  if [ -n "${BOOTSTRAP_AFTER:-}" ]; then
    target=$(date -u -d "$BOOTSTRAP_AFTER" +%s)
    now=$(date -u +%s)
    if [ "$now" -lt "$target" ]; then
      log "empty data directory; waiting $((target - now))s until $BOOTSTRAP_AFTER before the base backup"
      sleep $((target - now))
    fi
  fi

  conninfo="host=$PRIMARY_HOST port=$PRIMARY_PORT user=$REPLICATION_USER password=$REPLICATION_PASSWORD sslmode=prefer application_name=pg-replica"

  log "checking replication access to $PRIMARY_HOST:$PRIMARY_PORT as $REPLICATION_USER"
  gosu postgres psql "$conninfo dbname=postgres replication=database" -Atc "IDENTIFY_SYSTEM"

  # A slot left behind by an earlier failed bootstrap would make --create-slot
  # fail; dropping it first keeps the bootstrap idempotent.
  gosu postgres psql "$conninfo dbname=postgres" -Atc \
    "select pg_drop_replication_slot('$REPLICATION_SLOT') where exists (select 1 from pg_replication_slots where slot_name = '$REPLICATION_SLOT')" >/dev/null

  # A standby refuses to start with max_connections below the primary's, and
  # wrapper.sh writes 500 whenever postgresql.auto.conf has no value, so pin
  # the primary's figure explicitly.
  primary_max_connections=$(gosu postgres psql "$conninfo dbname=postgres" -Atc "show max_connections")

  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"

  # Refuse to start a copy the volume cannot hold. Filling the volume midway
  # would leave a broken data directory and a restart loop; sleeping keeps the
  # log readable and lets the volume be grown without a redeploy.
  needed_kb=$(gosu postgres psql "$conninfo dbname=postgres" -Atc "select ceil(sum(pg_database_size(oid)) / 1024) from pg_database")
  free_kb=$(df -Pk "$PGDATA" | awk 'NR==2 {print $4}')
  if [ "$free_kb" -lt $((needed_kb * 12 / 10)) ]; then
    log "volume too small: $((free_kb / 1024 / 1024)) GB free, primary holds $((needed_kb / 1024 / 1024)) GB (need 20% headroom). Grow the volume; retrying in 10 minutes"
    sleep 600
    exec "$0" "$@"
  fi

  log "base backup starting (slot $REPLICATION_SLOT)"
  gosu postgres pg_basebackup -d "$conninfo" -D "$PGDATA" -R -X stream \
    --create-slot --slot "$REPLICATION_SLOT" --checkpoint=fast --progress --verbose
  log "base backup complete"
  gosu postgres touch "$MARKER"

  # pg_basebackup copied the primary's postgresql.auto.conf (its ALTER SYSTEM
  # memory settings) and appended primary_conninfo / primary_slot_name. The
  # last occurrence of a setting in this file wins, so append the standby's own
  # values here. max_standby_streaming_delay = -1: never cancel a query on this
  # standby for a replication conflict — the nightly dump runs for over an hour
  # and must finish; replay simply waits and catches up afterwards.
  gosu postgres tee -a "$PGDATA/postgresql.auto.conf" >/dev/null <<CONF
# pg-replica standby settings (appended by replica-entrypoint.sh; later lines win)
max_connections = ${primary_max_connections}
hot_standby = on
max_standby_streaming_delay = -1
max_standby_archive_delay = -1
hot_standby_feedback = off
shared_buffers = '${REPLICA_SHARED_BUFFERS:-2GB}'
effective_cache_size = '${REPLICA_EFFECTIVE_CACHE_SIZE:-6GB}'
maintenance_work_mem = '256MB'
CONF
fi

exec /usr/local/bin/wrapper.sh "$@"
