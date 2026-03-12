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

BINARY_NAME="codecast-${PLATFORM}-${ARCH_NAME}"
INSTALL_DIR="${HOME}/.local/bin"

echo "Platform: ${PLATFORM}-${ARCH_NAME}"
echo "Install directory: ${INSTALL_DIR}"

DOWNLOAD_URL="${DOWNLOAD_HOST}/${BINARY_NAME}"

mkdir -p "${INSTALL_DIR}"

echo "Downloading cast..."
TEMP_FILE="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${DOWNLOAD_URL}" -o "${TEMP_FILE}"
elif command -v wget >/dev/null 2>&1; then
  wget -q "${DOWNLOAD_URL}" -O "${TEMP_FILE}"
else
  echo "Error: curl or wget is required"
  exit 1
fi

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

if ! echo "${PATH}" | grep -q "${INSTALL_DIR}"; then
  echo ""
  echo "Warning: ${INSTALL_DIR} is not in your PATH"
  echo "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo "  export PATH=\"\${HOME}/.local/bin:\${PATH}\""
  echo ""
  export PATH="${INSTALL_DIR}:${PATH}"
fi

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

if [ -n "${TOKEN}" ]; then
  echo "Linking device..."
  "${INSTALL_DIR}/codecast" login "${TOKEN}"
else
  # Restart daemon if it was running before
  if [ -n "${OLD_PID}" ] && [ -f "${HOME}/.codecast/config.json" ]; then
    echo "Restarting daemon..."
    "${INSTALL_DIR}/codecast" start 2>/dev/null || true
  else
    echo "Run 'cast auth' to authenticate and start syncing."
  fi
fi
