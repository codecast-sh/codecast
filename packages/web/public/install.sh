#!/bin/sh
set -e

# Codecast installer script
# Usage: curl -fsSL codecast.sh/install | sh

echo "Installing codecast..."

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

# Map to our binary names
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

# For MVP, only support macOS ARM
if [ "${PLATFORM}" != "darwin" ] || [ "${ARCH_NAME}" != "arm64" ]; then
  echo "Error: Currently only macOS ARM (Apple Silicon) is supported"
  echo "Detected: ${PLATFORM}-${ARCH_NAME}"
  exit 1
fi

BINARY_NAME="codecast-${PLATFORM}-${ARCH_NAME}"
INSTALL_DIR="${HOME}/.local/bin"
DOWNLOAD_URL="https://codecast.sh/download/${BINARY_NAME}"

echo "Platform: ${PLATFORM}-${ARCH_NAME}"
echo "Install directory: ${INSTALL_DIR}"

# Create install directory if it doesn't exist
mkdir -p "${INSTALL_DIR}"

# Download binary
echo "Downloading codecast..."
TEMP_FILE="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${DOWNLOAD_URL}" -o "${TEMP_FILE}"
elif command -v wget >/dev/null 2>&1; then
  wget -q "${DOWNLOAD_URL}" -O "${TEMP_FILE}"
else
  echo "Error: curl or wget is required"
  exit 1
fi

# Install binary
echo "Installing to ${INSTALL_DIR}/codecast..."
mv "${TEMP_FILE}" "${INSTALL_DIR}/codecast"
chmod +x "${INSTALL_DIR}/codecast"

# Check if in PATH
if ! echo "${PATH}" | grep -q "${INSTALL_DIR}"; then
  echo ""
  echo "⚠️  ${INSTALL_DIR} is not in your PATH"
  echo "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo "  export PATH=\"\${HOME}/.local/bin:\${PATH}\""
  echo ""

  # Add to PATH for this session
  export PATH="${INSTALL_DIR}:${PATH}"
fi

# Verify installation
if ! command -v codecast >/dev/null 2>&1; then
  echo "Error: codecast command not found after installation"
  echo "Try running: export PATH=\"\${HOME}/.local/bin:\${PATH}\""
  exit 1
fi

echo "✓ codecast installed successfully!"
echo ""
echo "Running setup..."
echo ""

# Run setup
codecast setup
