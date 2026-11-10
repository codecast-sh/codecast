#!/bin/bash
# Local patches for @convex-dev/auth, applied on postinstall to every copy
# (root and per-package node_modules, direct and bun-cached). Independent fixes
# live here:
#
#   1. iss-fix  — OAuth callback "unexpected iss response parameter" (RFC 9207)
#   2. reuse-window — widen refresh-token reuse window 10s -> 30 days
#   3. ios-oauth — Chrome iOS GitHub sign-in (see convex-auth-ios-oauth.mjs)
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

# Every copy of the package in the tree, the same list convex-auth-ios-oauth.mjs
# walks: bun gives each workspace package its own node_modules entry, and code
# resolves the package from ITS package, so a patch applied only at the root
# can be invisible to the file that reads it. Both patches are idempotent, so
# a copy reached through two symlinks is patched once.
AUTH_ROOTS=()
for root in node_modules/@convex-dev/auth \
            node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth \
            packages/*/node_modules/@convex-dev/auth \
            packages/*/node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth; do
  if [ -d "$root" ]; then AUTH_ROOTS+=("$root"); fi
done
# Nothing installed (a fresh checkout mid-install): nothing to patch.
if [ "${#AUTH_ROOTS[@]}" -eq 0 ]; then exit 0; fi

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

for root in "${AUTH_ROOTS[@]}"; do
  apply_patch "$root/src/server/oauth/callback.ts"
  apply_patch "$root/dist/server/oauth/callback.js"
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

for root in "${AUTH_ROOTS[@]}"; do
  apply_reuse_window_patch "$root/src/server/implementation/refreshTokens.ts"
  apply_reuse_window_patch "$root/dist/server/implementation/refreshTokens.js"
done

# ---------------------------------------------------------------------------
# Patch 3: Chrome iOS GitHub OAuth.
#
# Convex Auth sets PKCE/state/redirectTo as Partitioned SameSite=None cookies
# on a 302 bounce through CONVEX_SITE_URL. Chrome iOS WKWebView drops those
# cookies (it rejects Partitioned, and it often ignores Set-Cookie on a 302
# that immediately leaves the origin). The callback then fails silently and
# redirects to SITE_URL — the marketing homepage. Safari keeps the cookies,
# which is why the same button works there.
#
# The rewrite lives in convex-auth-ios-oauth.mjs (multi-line, idempotent).

bun "$(dirname "$0")/convex-auth-ios-oauth.mjs"
