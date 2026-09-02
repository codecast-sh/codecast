#!/bin/bash
# Local patches for @convex-dev/auth, applied on postinstall to every copy
# (direct node_modules + bun-cached). Two independent fixes live here:
#
#   1. iss-fix  — OAuth callback "unexpected iss response parameter" (RFC 9207)
#   2. reuse-window — widen refresh-token reuse window 10s -> 30 days
#
# ---------------------------------------------------------------------------
# Patch 1: OAuth callback "unexpected iss (issuer) response parameter value"
#
# Root cause: GitHub rolled out RFC 9207 (Authorization Server Issuer
# Identification) on ~2026-04-08, adding an `iss` parameter to OAuth
# authorization responses. The value is "https://github.com/login/oauth".
#
# @convex-dev/auth sets a dummy issuer ("theremustbeastringhere.dev") for
# non-OIDC providers, so oauth4webapi v3's validateAuthResponse() always
# rejects the iss mismatch. The error is silently caught in the callback
# handler, which redirects without a code — breaking sign-in.
#
# Fix: Strip the `iss` param from callback query params before validation.
# This is safe because iss validation only matters for multi-AS deployments
# (RFC 9207 mix-up attack mitigation), which doesn't apply here.
#
# Tracking:
#   - https://github.com/langfuse/langfuse/issues/13091 (same bug in Langfuse)
#   - https://datatracker.ietf.org/doc/html/rfc9207
#
# Remove this script once @convex-dev/auth ships a proper fix.

set -euo pipefail

apply_patch() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -q 'delete("iss")' "$file" 2>/dev/null && return 0

  # The sed pattern matches both the .ts (multi-line) and .js (single-line) forms
  if [[ "$file" == *.ts ]]; then
    # TypeScript src: replace multi-line validateAuthResponse call
    sed -i.bak '/new URLSearchParams(params),/{
      s/new URLSearchParams(params),/(() => { const p = new URLSearchParams(params); p.delete("iss"); return p; })(),/
    }' "$file"
  else
    # JavaScript dist: same replacement on single line
    sed -i.bak 's/new URLSearchParams(params),/(() => { const p = new URLSearchParams(params); p.delete("iss"); return p; })(),/' "$file"
  fi
  rm -f "$file.bak"
  echo "[convex-auth-iss-fix] Patched $file"
}

# Patch the direct node_modules copy
apply_patch "node_modules/@convex-dev/auth/src/server/oauth/callback.ts"
apply_patch "node_modules/@convex-dev/auth/dist/server/oauth/callback.js"

# Patch bun-cached copies (bun symlinks node_modules/@convex-dev/auth -> .bun/...)
for f in node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth/src/server/oauth/callback.ts \
         node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth/dist/server/oauth/callback.js; do
  apply_patch "$f"
done

# ---------------------------------------------------------------------------
# Patch 2: widen the refresh-token reuse window from 10s to 30 days.
#
# Root cause of recurring web logouts: the Convex client force-refreshes (and
# thus ROTATES) the refresh token on every websocket reconnect. With a flaky
# self-hosted backend (frequent reconnects) and many open tabs, a tab can
# present a refresh token that has fallen 2+ rotations behind. Convex Auth only
# tolerates re-presenting a rotated token for REFRESH_TOKEN_REUSE_WINDOW_MS
# (hardcoded 10s); past that it treats it as reuse/theft and invalidates the
# ENTIRE session subtree -> the next refresh returns null -> the user is logged
# out. We measured 328 sessions for one user, a new one every 1-3 days.
#
# Widening the window to 30 days makes a stale token get re-issued instead of
# killing the session, which absorbs reconnect storms, laptop sleeps, and
# multi-tab races. Tradeoff: a stolen+rotated refresh token stays replayable for
# up to 30 days (acceptable for this self-hosted personal/team deployment).
#
# The constant is hardcoded and not configurable via the auth config, so we
# rewrite it in place. Remove if @convex-dev/auth ever exposes this as a config.

apply_reuse_window_patch() {
  local file="$1"
  [ -f "$file" ] || return 0
  # Idempotent: skip if already widened (no 10-second literal left).
  grep -q 'REFRESH_TOKEN_REUSE_WINDOW_MS = 10 \* 1000' "$file" 2>/dev/null || return 0

  sed -i.bak 's/REFRESH_TOKEN_REUSE_WINDOW_MS = 10 \* 1000;.*/REFRESH_TOKEN_REUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; \/\/ codecast: widened from 10s to 30 days (reconnect-churn logout fix)/' "$file"
  rm -f "$file.bak"
  echo "[convex-auth-reuse-window] Patched $file"
}

# Direct copy + all bun-cached copies, .ts src and .js dist forms.
for f in node_modules/@convex-dev/auth/src/server/implementation/refreshTokens.ts \
         node_modules/@convex-dev/auth/dist/server/implementation/refreshTokens.js \
         node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth/src/server/implementation/refreshTokens.ts \
         node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth/dist/server/implementation/refreshTokens.js; do
  apply_reuse_window_patch "$f"
done
