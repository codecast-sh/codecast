#!/usr/bin/env bash
# Drive real `cast fork` against a sample of large conversations.
# Args: each "ID:LABEL" — LABEL = MINE or OTHER
set -uo pipefail
CAST=cast
results=()
fork_one() {
  local id="$1" label="$2" from="$3"
  local out shortid
  out=$($CAST fork "$id" --from "$from" 2>&1)
  shortid=$(printf '%s' "$out" | grep -oE 'New conversation: [a-z0-9]+' | awk '{print $3}')
  if [[ -z "$shortid" ]]; then
    echo "FORK-FAIL [$label] $id from=$from :: $(printf '%s' "$out" | tail -1)"
    return
  fi
  # give the batched copy a moment to advance
  sleep 2
  # read the fork's own message count from its tree node
  local tree mc
  tree=$($CAST tree "$shortid" 2>&1)
  mc=$(printf '%s' "$tree" | grep -oE "\($shortid, [0-9]+ msgs\)" | grep -oE '[0-9]+ msgs' | grep -oE '[0-9]+')
  echo "FORK-OK   [$label] src=$id from=$from -> $shortid  copied=${mc:-?} (expected≈$from)"
}
for spec in "$@"; do
  id="${spec%%:*}"; label="${spec##*:}"
  echo "### $label $id"
  fork_one "$id" "$label" 5
  fork_one "$id" "$label" 50
done
