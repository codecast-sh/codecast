#!/usr/bin/env bash
# Runs the ct-101961 check: the replay recorder must not snapshot the page
# inside a document input handler when it wakes from its idle sleep.
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ -d platform/packages/analytics/node_modules/happy-dom ]] || (cd platform && bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null)
exec bun test tests/replay-wake/replayWake.test.ts
