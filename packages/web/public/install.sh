#!/bin/sh
set -e

DOWNLOAD_HOST="https://dl.codecast.sh"
TOKEN="${1:-}"

echo "Installing cast..."

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin*)
    PLATFORM="darwin"
    ;;
  Linux*)
    PLATFORM="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "This looks like Windows running a POSIX shell."
    echo "codecast on Windows runs inside WSL. Run the Windows installer in PowerShell:"
    echo '  irm codecast.sh/install.ps1 | iex'
    echo "It sets up WSL if needed and installs codecast inside it."
    echo "To link a device with a token:"
    echo '  $env:CODECAST_SETUP_TOKEN="<token>"; irm codecast.sh/install.ps1 | iex'
    exit 1
    ;;
  *)
    echo "Error: Unsupported operating system: ${OS}"
    echo "Supported: macOS, Linux"
    exit 1
    ;;
esac

case "${ARCH}" in
  x86_64|amd64)
    ARCH_NAME="x64"
    ;;
  arm64|aarch64)
    ARCH_NAME="arm64"
    ;;
  *)
    echo "Error: Unsupported architecture: ${ARCH}"
    echo "Supported: x86_64, arm64"
    exit 1
    ;;
esac

PLATFORM_KEY="${PLATFORM}-${ARCH_NAME}"
INSTALL_DIR="${HOME}/.local/bin"

echo "Platform: ${PLATFORM_KEY}"
echo "Install directory: ${INSTALL_DIR}"

# One download tool for the manifest and the binary. curl is held to https on
# every hop; wget follows only https too (--https-only).
if command -v curl >/dev/null 2>&1; then
  fetch_text() { curl -fsSL --proto '=https' --proto-redir '=https' --max-redirs 3 "$1"; }
  # --progress-bar (instead of -s) so the ~70MB binary shows download movement
  # rather than looking frozen; -f still fails on HTTP errors, -L still follows
  # redirects. The bar goes to stderr, which is the user's terminal under `| sh`.
  fetch_file() { curl -fL --proto '=https' --proto-redir '=https' --max-redirs 3 --progress-bar "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch_text() { wget -q --https-only --max-redirect=3 -O - "$1"; }
  # --show-progress keeps the bar while -q silences wget's other chatter.
  fetch_file() { wget -q --https-only --max-redirect=3 --show-progress "$1" -O "$2"; }
else
  echo "Error: curl or wget is required"
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "Error: sha256sum or shasum is required to verify the download"
  exit 1
fi

# The release manifest names the exact binary for this platform and its
# SHA-256. The installer takes the binary only from the release host and
# refuses to install bytes whose digest does not match, so a wrong or altered
# download never lands in PATH.
echo "Reading release manifest..."
MANIFEST="$(fetch_text "${DOWNLOAD_HOST}/latest.json")" || {
  echo "Error: could not read ${DOWNLOAD_HOST}/latest.json"
  exit 1
}
# Compact the JSON (no field of interest contains whitespace), cut this
# platform's entry, then read its url and sha256 whatever their order.
ENTRY="$(printf '%s' "${MANIFEST}" | tr -d ' \n\r\t' | sed -n "s/.*\"${PLATFORM_KEY}\":{\([^}]*\)}.*/\1/p")"
DOWNLOAD_URL="$(printf '%s' "${ENTRY}" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
EXPECTED_SHA="$(printf '%s' "${ENTRY}" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p' | tr 'A-F' 'a-f')"
RELEASE_VERSION="$(printf '%s' "${MANIFEST}" | tr -d ' \n\r\t' | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"

if [ -z "${ENTRY}" ]; then
  echo "Error: manifest has no binary for ${PLATFORM_KEY}; refusing to install"
  exit 1
fi
case "${DOWNLOAD_URL}" in
  "${DOWNLOAD_HOST}"/*) ;;
  *)
    echo "Error: manifest names a binary outside ${DOWNLOAD_HOST}; refusing to install"
    exit 1
    ;;
esac
if printf '%s' "${DOWNLOAD_URL}" | LC_ALL=C grep -q '[^A-Za-z0-9._~/:-]'; then
  echo "Error: manifest binary URL contains characters the installer does not accept; refusing to install"
  exit 1
fi
if ! printf '%s' "${EXPECTED_SHA}" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$'; then
  echo "Error: manifest has no SHA-256 for ${PLATFORM_KEY}; refusing to install"
  exit 1
fi

mkdir -p "${INSTALL_DIR}"

echo "Downloading cast${RELEASE_VERSION:+ v${RELEASE_VERSION}}..."
TEMP_FILE="$(mktemp)"
fetch_file "${DOWNLOAD_URL}" "${TEMP_FILE}"

ACTUAL_SHA="$(digest_of "${TEMP_FILE}")"
if [ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]; then
  rm -f "${TEMP_FILE}"
  echo "Error: downloaded binary does not match the release manifest (expected ${EXPECTED_SHA}, got ${ACTUAL_SHA}); refusing to install"
  exit 1
fi
echo "Verified SHA-256."

# Stop running daemon before replacing binary
PID_FILE="${HOME}/.codecast/daemon.pid"
if [ -f "${PID_FILE}" ]; then
  OLD_PID=$(cat "${PID_FILE}" 2>/dev/null)
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "Stopping running daemon (PID: ${OLD_PID})..."
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 1
  fi
fi

echo "Installing to ${INSTALL_DIR}/codecast..."
mv "${TEMP_FILE}" "${INSTALL_DIR}/codecast"
chmod +x "${INSTALL_DIR}/codecast"
ln -sf "${INSTALL_DIR}/codecast" "${INSTALL_DIR}/cast"

# Append a PATH line to a shell profile, idempotently. Sets CONFIGURED_PROFILE on
# success. An unwritable profile (e.g. root-owned ~/.zshrc on EC2 Mac hosts) must
# not abort the install under set -e — record it in PROFILE_SKIPPED instead so the
# wrap-up prints manual instructions.
add_to_path() {
  profile="$1"
  line="$2"
  # Only touch a profile whose parent directory exists (so we don't create stray dirs)
  [ -d "$(dirname "${profile}")" ] || return 0
  # Skip if this profile already references the install dir
  if [ -f "${profile}" ] && grep -qs '\.local/bin' "${profile}"; then
    return 0
  fi
  # 2>/dev/null before >> : redirections apply left to right, so the shell's own
  # "Permission denied" message for a failed append lands in /dev/null, not the terminal
  if printf '\n# Added by codecast installer\n%s\n' "${line}" 2>/dev/null >> "${profile}"; then
    echo "  Added ${INSTALL_DIR} to PATH in ${profile}"
    CONFIGURED_PROFILE="${profile}"
  else
    echo "  Skipped ${profile} (not writable)"
    PROFILE_SKIPPED="${profile}"
    PROFILE_SKIPPED_LINE="${line}"
  fi
}

CONFIGURED_PROFILE=""
PROFILE_SKIPPED=""
PROFILE_SKIPPED_LINE=""
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*)
    : # already on PATH, nothing to do
    ;;
  *)
    echo ""
    echo "Adding ${INSTALL_DIR} to your PATH..."
    POSIX_LINE="export PATH=\"\$HOME/.local/bin:\$PATH\""
    case "$(basename "${SHELL:-/bin/sh}")" in
      zsh)
        add_to_path "${ZDOTDIR:-$HOME}/.zshrc" "${POSIX_LINE}"
        ;;
      bash)
        add_to_path "${HOME}/.bashrc" "${POSIX_LINE}"
        if [ -f "${HOME}/.bash_profile" ]; then
          add_to_path "${HOME}/.bash_profile" "${POSIX_LINE}"
        else
          add_to_path "${HOME}/.profile" "${POSIX_LINE}"
        fi
        ;;
      fish)
        add_to_path "${HOME}/.config/fish/config.fish" "fish_add_path \"\$HOME/.local/bin\""
        ;;
      *)
        add_to_path "${HOME}/.profile" "${POSIX_LINE}"
        ;;
    esac
    # Make cast usable for the rest of THIS script run (does not affect the parent shell)
    export PATH="${INSTALL_DIR}:${PATH}"
    ;;
esac

# Check for stale installs that might shadow the new binary
for CMD_NAME in codecast cast; do
  RESOLVED="$(command -v ${CMD_NAME} 2>/dev/null || true)"
  if [ -n "${RESOLVED}" ] && [ "${RESOLVED}" != "${INSTALL_DIR}/${CMD_NAME}" ]; then
    echo "Warning: found another ${CMD_NAME} at ${RESOLVED}"
    echo "Removing stale install to avoid conflicts..."
    rm -f "${RESOLVED}" 2>/dev/null || echo "  Could not remove ${RESOLVED} (permission denied). Please remove it manually."
  fi
done

if ! command -v cast >/dev/null 2>&1 && ! command -v codecast >/dev/null 2>&1; then
  echo "Error: cast command not found after installation"
  echo "Try running: export PATH=\"\${HOME}/.local/bin:\${PATH}\""
  exit 1
fi

echo "cast installed successfully! (also available as codecast)"
echo ""

if [ -n "${CONFIGURED_PROFILE}" ]; then
  echo "PATH updated in ${CONFIGURED_PROFILE}."
  echo "To use 'cast' in this shell right now, run:"
  echo "  source \"${CONFIGURED_PROFILE}\""
  echo "Otherwise just open a new terminal."
  echo ""
elif [ -n "${PROFILE_SKIPPED}" ]; then
  echo "PATH not updated: ${PROFILE_SKIPPED} is not writable by you."
  echo "Fix its ownership (sudo chown \"\$(whoami)\" \"${PROFILE_SKIPPED}\") or add this"
  echo "line to your shell profile yourself:"
  echo "  ${PROFILE_SKIPPED_LINE}"
  echo ""
fi

INSTALL_TTY=""
exec 3<&1
for INSTALL_FD in 0 3 2; do
  INSTALL_TTY_CANDIDATE="$(tty <&"${INSTALL_FD}" 2>/dev/null)" || continue
  case "${INSTALL_TTY_CANDIDATE}" in
    /dev/tty) continue ;;
    /dev/*)
      if ( : < "${INSTALL_TTY_CANDIDATE}" ) 2>/dev/null; then
        INSTALL_TTY="${INSTALL_TTY_CANDIDATE}"
        break
      fi
      ;;
  esac
done
exec 3<&-

if [ -n "${TOKEN}" ]; then
  echo "Linking device..."
  if [ -n "${INSTALL_TTY}" ]; then
    "${INSTALL_DIR}/codecast" login "${TOKEN}" < "${INSTALL_TTY}"
  else
    "${INSTALL_DIR}/codecast" login "${TOKEN}" < /dev/null
  fi
else
  if [ -f "${HOME}/.codecast/config.json" ]; then
    # Already authenticated (fresh install or update) — make sure the daemon runs
    echo "Existing login found. Starting daemon..."
    "${INSTALL_DIR}/codecast" start 2>/dev/null || true
  elif [ -n "${INSTALL_TTY}" ]; then
    echo "Next: sign in to link this machine (opens your browser)."
    echo ""
    if ! "${INSTALL_DIR}/codecast" auth < "${INSTALL_TTY}"; then
      echo ""
      echo "Sign-in did not complete. Run 'cast auth' anytime to finish setup."
    fi
  else
    # Headless/CI install with no terminal to prompt from
    echo "Run 'cast auth' to authenticate and start syncing."
  fi
fi
