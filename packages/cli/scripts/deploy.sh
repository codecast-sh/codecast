#!/bin/bash
set -e

cd "$(dirname "$0")/.."

FORCE_UPDATE=false
BUMP_TYPE="patch"
NO_BUMP=false
SKIP_CHECKS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --force)
      FORCE_UPDATE=true
      shift
      ;;
    --no-bump)
      NO_BUMP=true
      shift
      ;;
    --skip-checks)
      SKIP_CHECKS=true
      shift
      ;;
    patch|minor|major)
      BUMP_TYPE="$1"
      shift
      ;;
    *)
      echo "Usage: ./scripts/deploy.sh [patch|minor|major] [--force] [--no-bump] [--skip-checks]"
      echo "  patch|minor|major  Version bump type (default: patch)"
      echo "  --force            Force all remote clients to update immediately"
      echo "  --no-bump          Redeploy current version (recovery after partial failure)"
      echo "  --skip-checks      Skip the pre-deploy typecheck + test gate (NOT recommended)"
      exit 1
      ;;
  esac
done

# Pre-deploy gate: never ship binaries that don't typecheck or pass tests.
# Hard-gates by default; `--skip-checks` is an explicit, discouraged override.
if [[ "$SKIP_CHECKS" == "true" ]]; then
  echo "WARNING: skipping pre-deploy typecheck + test gate (--skip-checks)"
else
  echo "Running pre-deploy checks (typecheck + tests)..."
  echo "  tsc --noEmit"
  if ! bun run typecheck; then
    echo "ABORT: typecheck failed — fix the type errors or pass --skip-checks to override." >&2
    exit 1
  fi
  echo "  bun test src/"
  if ! bun test src/; then
    echo "ABORT: cli tests failed — fix the failures or pass --skip-checks to override." >&2
    exit 1
  fi
  echo "Pre-deploy checks passed."
fi

if [ -f .env.deploy ]; then
  export $(cat .env.deploy | xargs)
fi

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID or create .env.deploy}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY or create .env.deploy}"

R2_BUCKET="codecast"
: "${R2_ENDPOINT:?Set R2_ENDPOINT (e.g. https://<account-id>.r2.cloudflarestorage.com)}"
export AWS_DEFAULT_REGION="auto"
BINARIES_DIR="../web/binaries"
# The exact outputs of one build-binaries.sh run. Every consumer (R2 upload,
# prewarm, GitHub release) iterates this list — never glob the dir, which
# accumulates strays across runs (a local `cast` symlink once shipped to R2
# as a duplicate object).
ARTIFACTS=(codecast-darwin-arm64 codecast-darwin-x64 codecast-linux-arm64 codecast-linux-x64 codecast-windows-x64.exe)

# Version bump (package.json is the single source of truth — update.ts imports it)
if [[ "$NO_BUMP" == "true" ]]; then
  VERSION=$(jq -r '.version' package.json)
  echo "Redeploying v$VERSION (no bump)"
else
  OLD_VERSION=$(jq -r '.version' package.json)
  IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
  case "$BUMP_TYPE" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
  esac
  VERSION="$MAJOR.$MINOR.$PATCH"
  jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
  echo "Version: $OLD_VERSION -> $VERSION"
fi

echo "Deploying codecast CLI v$VERSION"

# Build binaries
echo ""
echo "Building binaries..."
./scripts/build-binaries.sh

# Upload binaries
echo ""
echo "Uploading binaries to R2..."
for filename in "${ARTIFACTS[@]}" main.js.map; do
  echo "  $filename"
  aws s3 cp "$BINARIES_DIR/$filename" "s3://$R2_BUCKET/$filename" \
    --endpoint-url "$R2_ENDPOINT" \
    --content-type "application/octet-stream" \
    --quiet
done

# Generate checksums and latest.json
echo ""
echo "Generating latest.json..."
LATEST_JSON=$(cat <<EOF
{
  "version": "$VERSION",
  "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "binaries": {
    "darwin-arm64": {
      "url": "https://dl.codecast.sh/codecast-darwin-arm64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-darwin-arm64" | cut -d' ' -f1)"
    },
    "darwin-x64": {
      "url": "https://dl.codecast.sh/codecast-darwin-x64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-darwin-x64" | cut -d' ' -f1)"
    },
    "linux-arm64": {
      "url": "https://dl.codecast.sh/codecast-linux-arm64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-linux-arm64" | cut -d' ' -f1)"
    },
    "linux-x64": {
      "url": "https://dl.codecast.sh/codecast-linux-x64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-linux-x64" | cut -d' ' -f1)"
    },
    "windows-x64": {
      "url": "https://dl.codecast.sh/codecast-windows-x64.exe",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-windows-x64.exe" | cut -d' ' -f1)"
    }
  }
}
EOF
)

echo "$LATEST_JSON" > /tmp/latest.json
aws s3 cp /tmp/latest.json "s3://$R2_BUCKET/latest.json" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/json" \
  --quiet

echo ""
echo "Deployed v$VERSION"
echo "  https://dl.codecast.sh/latest.json"

# Prewarm the CDN BEFORE force-update flips the fleet: the first fetch of each
# binary after upload streams from the R2 origin (slow from distant edges),
# and force-update makes every daemon download within ~5 minutes. One GET
# through the public domain caches at this edge and, with Tiered Cache enabled
# on the zone, at the upper tier all other edges fill from. Best-effort.
echo "Prewarming CDN..."
for b in "${ARTIFACTS[@]}"; do
  curl -so /dev/null --max-time 300 -w "  $b: %{speed_download} B/s\n" "https://dl.codecast.sh/$b" || echo "  $b: prewarm failed (non-fatal)"
done

# Sync the npm distribution package (version + per-platform checksums).
# npm/install.js and the Homebrew formula both install the GitHub release
# assets for exactly this version, verified against these hashes.
sha() { shasum -a 256 "$BINARIES_DIR/$1" | cut -d' ' -f1; }
jq --arg v "$VERSION" '.version = $v' npm/package.json > npm/package.json.tmp && mv npm/package.json.tmp npm/package.json
jq -n \
  --arg da "$(sha codecast-darwin-arm64)" \
  --arg dx "$(sha codecast-darwin-x64)" \
  --arg la "$(sha codecast-linux-arm64)" \
  --arg lx "$(sha codecast-linux-x64)" \
  --arg wx "$(sha codecast-windows-x64.exe)" \
  '{"darwin-arm64":$da,"darwin-x64":$dx,"linux-arm64":$la,"linux-x64":$lx,"windows-x64":$wx}' \
  > npm/checksums.json

# Commit version bump
if [[ "$NO_BUMP" == "false" ]]; then
  git add package.json npm/package.json npm/checksums.json
  git commit -m "chore(cli): bump version to $VERSION"
  git push
fi

if [[ "$FORCE_UPDATE" == "true" ]]; then
  echo ""
  echo "Setting minimum CLI version to force remote updates..."
  codecast force-update "$VERSION"
else
  echo ""
  echo "To force all remote clients to update:"
  echo "  codecast force-update $VERSION"
fi

# GitHub release: tag v$VERSION and attach the same binaries that went to R2.
# Runs last and never fails the deploy — R2 + force-update are the real release;
# this is the public changelog. On --no-bump redeploys the release already
# exists, so just refresh its assets.
echo ""
echo "Publishing GitHub release v$VERSION..."
RELEASE_FILES=("${ARTIFACTS[@]/#/$BINARIES_DIR/}" "$BINARIES_DIR/main.js.map")
if gh release view "v$VERSION" >/dev/null 2>&1; then
  # A --no-bump rerun after a failed partial deploy refreshes these assets
  # while R2 may still hold the old bytes; R2 is authoritative mid-incident.
  gh release upload "v$VERSION" "${RELEASE_FILES[@]}" --clobber \
    || echo "  WARNING: asset refresh failed (non-fatal)"
else
  gh release create "v$VERSION" "${RELEASE_FILES[@]}" --generate-notes \
    || echo "  WARNING: GitHub release failed (non-fatal) — rerun: gh release create v$VERSION with the files in $BINARIES_DIR"
fi

# npm + Homebrew ride the GitHub release assets published above. Both are
# non-fatal: R2 + force-update are the real release, these are mirrors.
echo ""
echo "Publishing to npm..."
if [ -n "${NPM_TOKEN:-}" ]; then
  # Granular access token (bypass 2FA) from .env.deploy. The npmrc holds the
  # literal ${NPM_TOKEN} placeholder — npm expands it from the environment, so
  # the token itself never touches disk.
  NPMRC=$(mktemp)
  echo '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > "$NPMRC"
  (cd npm && npm publish --access public --userconfig "$NPMRC") \
    || echo "  WARNING: npm publish failed (non-fatal) — rerun: cd npm && npm publish --access public"
  command rm -f "$NPMRC"
elif npm whoami >/dev/null 2>&1; then
  (cd npm && npm publish --access public) \
    || echo "  WARNING: npm publish failed (non-fatal) — rerun: cd npm && npm publish --access public"
else
  echo "  WARNING: no NPM_TOKEN in .env.deploy and not logged in to npm — skipped. Rerun: cd npm && npm publish --access public"
fi

echo ""
echo "Updating Homebrew tap..."
FORMULA_B64=$(./scripts/make-formula.sh "$VERSION" npm/checksums.json | base64)
FORMULA_SHA=$(gh api repos/codecast-sh/homebrew-tap/contents/Formula/codecast.rb -q .sha 2>/dev/null || true)
gh api -X PUT repos/codecast-sh/homebrew-tap/contents/Formula/codecast.rb \
  -f message="codecast $VERSION" \
  -f content="$FORMULA_B64" \
  ${FORMULA_SHA:+-f sha="$FORMULA_SHA"} >/dev/null \
  && echo "  Formula updated to $VERSION" \
  || echo "  WARNING: tap update failed (non-fatal) — rerun: ./scripts/make-formula.sh $VERSION npm/checksums.json, push to codecast-sh/homebrew-tap"
