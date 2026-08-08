#!/bin/bash
# Emits the Homebrew formula for codecast to stdout.
# Usage: make-formula.sh <version> <checksums.json>
# The checksums file is the same one the npm package ships (packages/cli/npm/checksums.json).
set -euo pipefail

VERSION="$1"
CHECKSUMS="$2"

sha() { jq -r --arg k "$1" '.[$k]' "$CHECKSUMS"; }

BASE="https://github.com/codecast-sh/codecast/releases/download/v${VERSION}"

cat <<EOF
class Codecast < Formula
  desc "See, steer, and remember every coding agent session"
  homepage "https://codecast.sh"
  version "${VERSION}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${BASE}/codecast-darwin-arm64"
      sha256 "$(sha darwin-arm64)"
    else
      url "${BASE}/codecast-darwin-x64"
      sha256 "$(sha darwin-x64)"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${BASE}/codecast-linux-arm64"
      sha256 "$(sha linux-arm64)"
    else
      url "${BASE}/codecast-linux-x64"
      sha256 "$(sha linux-x64)"
    end
  end

  def install
    binary = Dir["codecast-*"].first
    bin.install binary => "codecast"
    chmod 0755, bin/"codecast"
    bin.install_symlink "codecast" => "cast"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/codecast --version").strip
  end
end
EOF
