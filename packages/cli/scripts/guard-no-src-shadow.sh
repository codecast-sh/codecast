#!/bin/bash
# Fail loudly if a compiled .js "shadow" sits next to its .ts source under src/.
#
# Why this matters: index.ts loads the daemon via `await import("./daemon.js")`.
# When a real src/daemon.js file exists, bun's resolver binds to that exact file
# instead of extension-substituting to daemon.ts — so edits to daemon.ts compile
# and the binary builds with zero errors, but STALE code ships. The failure is
# invisible (right version, no error); the only symptom is wrong behavior.
#
# We no longer generate any such shadow (the binary bundles daemon.ts directly),
# so any *.js next to a *.ts under src/ is a stale artifact that must be removed.
set -euo pipefail
cd "$(dirname "$0")/.."

shadows=""
while IFS= read -r js; do
  ts="${js%.js}.ts"
  [ -f "$ts" ] && shadows+="  $js"$'\n'
done < <(find src -name '*.js' 2>/dev/null)

if [ -n "$shadows" ]; then
  echo "ERROR: stale compiled .js shadow(s) found next to TypeScript sources in packages/cli/src/:" >&2
  printf '%s' "$shadows" >&2
  echo "" >&2
  echo "These hijack bun's import('./<name>.js') resolution and silently ship stale code." >&2
  echo "Remove them and rebuild:" >&2
  printf '%s' "$shadows" | sed 's/^  /  rm /' >&2
  exit 1
fi
