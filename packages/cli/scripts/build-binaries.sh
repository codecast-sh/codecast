#!/bin/bash
set -e

cd "$(dirname "$0")/.."

OUTPUT_DIR="../web/binaries"
mkdir -p "$OUTPUT_DIR"

# Refuse to build if a stale src/*.js shadow is present — it would hijack
# import("./daemon.js") and silently bundle old code. The --compile step below
# bundles daemon.ts directly, so no pre-compiled daemon.js intermediate is needed.
bash scripts/guard-no-src-shadow.sh

bun test src/daemonPid.test.ts src/daemonPid.cli.test.ts

# The daemon build id must match the source it is stamped from. Both release
# paths (deploy.sh and cut-cli-release.yml) run this script, so one check line
# covers both. It only verifies: the finalize workflow rejects a release whose
# packages/cli tree differs from the commit it built, so the stamp has to be a
# source edit a developer committed.
bun scripts/stamp-daemon-build-id.ts --check

# Resolve the signing identity BEFORE anything is signed, and export it. Two
# things get signed in this script — the CLI binaries below and the cast computer
# helper embedded in them — and macOS keys a TCC grant to the signing identity,
# so they must use the same one. Left unexported, build-with-native.ts sees no
# identity and falls back to an ad-hoc signature, which resets every user's
# Accessibility grant on every release: the exact failure the helper's fixed path
# exists to prevent. Checking the keychain here also fails a laptop release in a
# second rather than after five compiles. (ct-49524)
SIGNING=false
if [[ "$(uname)" == "Darwin" ]]; then
  export CODECAST_SIGN_IDENTITY="${CODECAST_SIGN_IDENTITY:-Developer ID Application: Ashot Petrosian (WRG9THCK9Q)}"
  if [[ "${CODECAST_SKIP_SIGN:-}" == "1" ]]; then
    echo "WARNING: skipping macOS code signing (CODECAST_SKIP_SIGN=1) — ad-hoc binaries reset TCC grants on every update"
  elif ! security find-identity -v -p codesigning | grep -qF "$CODECAST_SIGN_IDENTITY"; then
    echo "ABORT: signing identity not found in keychain: $CODECAST_SIGN_IDENTITY" >&2
    echo "Install the Developer ID cert, set CODECAST_SIGN_IDENTITY, or set CODECAST_SKIP_SIGN=1 (ships ad-hoc binaries that re-prompt TCC on every update)." >&2
    exit 1
  else
    SIGNING=true
  fi
fi

# The cast computer helper is a signed `codecast computer.app` that rides inside
# the darwin binaries as a tar. Build and sign it ONCE, here, and point every
# compile target at the same bytes: a tar records mtimes, so a per-target build
# would give darwin-arm64 and darwin-x64 different helpers and the release would
# have no single hash to record as the helper's identity. (ct-49524)
if [[ "$(uname)" == "Darwin" && "${CODECAST_SKIP_COMPUTER_HELPER:-}" != "1" ]]; then
  bun scripts/computer-helper-release.ts build "$(cd "$OUTPUT_DIR" && pwd)/computer-helper.tar"
  export CODECAST_COMPUTER_HELPER_TAR="$(cd "$OUTPUT_DIR" && pwd)/computer-helper.tar"
else
  rm -f "$OUTPUT_DIR/computer-helper.tar" "$OUTPUT_DIR/computer-helper.json"
fi

echo "Building codecast binaries..."

# Build for each platform
# bun compile supports: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64

targets=(
  "darwin-arm64"
  "darwin-x64"
  "linux-arm64"
  "linux-x64"
  "windows-x64"
)

for target in "${targets[@]}"; do
  echo "Building for $target..."

  if [[ "$target" == "windows-x64" ]]; then
    outfile="$OUTPUT_DIR/codecast-$target.exe"
  else
    outfile="$OUTPUT_DIR/codecast-$target"
  fi

  bun scripts/build-with-native.ts src/main.ts --compile --target="bun-$target" --minify --sourcemap --outfile="$outfile"

  echo "  -> $outfile"
done

# Re-sign the macOS binaries with a stable Developer ID identity. bun's
# --compile output is ad-hoc, linker-signed (Identifier=a.out), so its
# code-signing identity IS the content hash — every release looks like a
# brand-new app to macOS. TCC grants (e.g. the Documents-folder prompt when a
# user's projects live there) and Background Task Management items are keyed
# to that identity, so ad-hoc binaries re-prompt users after every
# self-update. A stable identifier + Developer ID cert makes grants survive.
# No hardened runtime: bun/JSC needs JIT, and TCC stability doesn't require it.
if [[ "$SIGNING" == "true" ]]; then
  echo ""
  echo "Signing macOS binaries..."
  for target in darwin-arm64 darwin-x64; do
    codesign --force --sign "$CODECAST_SIGN_IDENTITY" --identifier sh.codecast.cli --timestamp "$OUTPUT_DIR/codecast-$target"
    echo "  signed codecast-$target"
  done
fi

# Post-build check for the embedded helper: unpack it, run `codesign --verify
# --strict` and `spctl --assess` on the bundle, prove the darwin binaries can
# still read the asset back after `bun build --compile`, and prove the linux and
# windows ones carry no macOS helper at all. Writes computer-helper.json, which
# the release manifest reads. (ct-49524)
if [[ -n "${CODECAST_COMPUTER_HELPER_TAR:-}" ]]; then
  echo ""
  echo "Verifying the embedded cast computer helper..."
  helper_args=(--version "$(jq -r '.version' package.json)")
  if [[ "$SIGNING" == "true" ]]; then
    helper_args+=(--identity "$CODECAST_SIGN_IDENTITY")
  else
    helper_args+=(--allow-adhoc)
  fi
  bun scripts/computer-helper-release.ts verify "$OUTPUT_DIR" "${helper_args[@]}"
elif [[ "$(uname)" == "Darwin" ]]; then
  # No helper in this build, but the split check still has to run: it is what
  # keeps `cast --help` from parsing every lazy command group, and a build that
  # skips the helper is exactly where a lost --splitting would go unnoticed
  # until a release. (ct-49751)
  echo ""
  bun scripts/computer-helper-release.ts boot "$OUTPUT_DIR"
fi

echo ""
echo "All binaries built:"
ls -lh "$OUTPUT_DIR"
