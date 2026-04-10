#!/bin/bash
# Workaround for @convex-dev/auth OAuth callback failing with:
#   "unexpected iss (issuer) response parameter value"
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
