#!/usr/bin/env bash
# Run by `bun install` (the root postinstall): points git at the tracked hooks
# in .githooks, only where nothing else owns the hooks. It never fails the
# install, and does nothing outside a git checkout of this repository (a CI
# tarball, a copy inside another repository).
set -u

root=$(cd "$(dirname "$0")/.." && pwd -P) || exit 0
[ -n "${CI:-}" ] && exit 0
[ -d "$root/.githooks" ] || exit 0
top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ "$(cd "$top" && pwd -P)" = "$root" ] || exit 0

# Set already (ours, a hook manager's, or a global one): leave it.
[ -z "$(git -C "$root" config --get core.hooksPath 2>/dev/null)" ] || exit 0
# Hooks of someone's own in .git/hooks would stop running once hooksPath is set.
common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
for f in "$common"/hooks/*; do
  [ -f "$f" ] || continue
  case "$f" in *.sample) ;; *) exit 0 ;; esac
done

git -C "$root" config core.hooksPath .githooks 2>/dev/null || true
exit 0
