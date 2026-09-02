#!/bin/bash
# After upload-binaries.sh: publish the GitHub release, the npm shim and the
# Homebrew formula. Ported from the tail of codecast's deploy.sh. Every step is
# non fatal by design: R2 plus the minimum version switch is the real release;
# these are mirrors that install the GitHub release assets.
# Usage: publish-mirrors.sh <version>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/release.env" ] && set -a && . "$HERE/release.env" && set +a

VERSION="${1:?Usage: publish-mirrors.sh <version>}"
: "${BINARY_NAME:?}"; : "${GITHUB_REPO:?}"; : "${HOMEBREW_TAP_REPO:?}"
OUTPUT_DIR="${OUTPUT_DIR:-../web/binaries}"
NPM_DIR="${NPM_DIR:-npm}"
ARTIFACTS=("$BINARY_NAME-darwin-arm64" "$BINARY_NAME-darwin-x64" "$BINARY_NAME-linux-arm64" "$BINARY_NAME-linux-x64" "$BINARY_NAME-windows-x64.exe")
FILES=("${ARTIFACTS[@]/#/$OUTPUT_DIR/}")

echo "GitHub release v$VERSION..."
if gh release view "v$VERSION" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "${FILES[@]}" --clobber --repo "$GITHUB_REPO" || echo "  WARNING: asset refresh failed (non-fatal)"
else
  gh release create "v$VERSION" "${FILES[@]}" --generate-notes --repo "$GITHUB_REPO" || echo "  WARNING: release failed (non-fatal)"
fi

echo "npm..."
if [ -n "${NPM_TOKEN:-}" ]; then
  # The npmrc holds the literal placeholder; npm expands it from the environment,
  # so the token never touches disk.
  NPMRC=$(mktemp); echo '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > "$NPMRC"
  (cd "$NPM_DIR" && npm publish --access public --userconfig "$NPMRC") || echo "  WARNING: npm publish failed (non-fatal)"
  command rm -f "$NPMRC"
elif npm whoami >/dev/null 2>&1; then
  (cd "$NPM_DIR" && npm publish --access public) || echo "  WARNING: npm publish failed (non-fatal)"
else
  echo "  WARNING: no NPM_TOKEN and not logged in; skipped"
fi

echo "Homebrew tap..."
FORMULA_B64=$("$HERE/make-formula.sh" "$VERSION" "$NPM_DIR/checksums.json" | base64)
FORMULA_PATH="Formula/$BINARY_NAME.rb"
FORMULA_SHA=$(gh api "repos/$HOMEBREW_TAP_REPO/contents/$FORMULA_PATH" -q .sha 2>/dev/null || true)
gh api -X PUT "repos/$HOMEBREW_TAP_REPO/contents/$FORMULA_PATH" \
  -f message="$BINARY_NAME $VERSION" -f content="$FORMULA_B64" ${FORMULA_SHA:+-f sha="$FORMULA_SHA"} >/dev/null \
  && echo "  formula updated to $VERSION" || echo "  WARNING: tap update failed (non-fatal)"
