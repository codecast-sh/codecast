#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "=== Codecast Deployment Script ==="
echo ""

# Check for Railway CLI
if ! command -v railway &> /dev/null; then
    echo "Error: Railway CLI not found"
    echo "Install with: npm install -g @railway/cli"
    exit 1
fi

# Build CLI binaries
echo "Building CLI binaries..."
cd packages/cli
./scripts/build-binaries.sh
cd ../..

# Build Convex (generate types)
echo ""
echo "Building Convex..."
cd packages/convex
bun run build 2>/dev/null || true
cd ../..

# Build web
echo ""
echo "Building web..."
cd packages/web
bun run build
cd ../..

# Deploy to Railway
echo ""
echo "Deploying to Railway..."
railway up

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Binary downloads available at:"
echo "  - https://codecast.sh/download/codecast-darwin-arm64"
echo "  - https://codecast.sh/download/codecast-darwin-x64"
echo "  - https://codecast.sh/download/codecast-linux-arm64"
echo "  - https://codecast.sh/download/codecast-linux-x64"
echo "  - https://codecast.sh/download/codecast-windows-x64.exe"
echo ""
echo "Install scripts:"
echo "  - curl -fsSL codecast.sh/install | sh       (macOS/Linux)"
echo "  - irm codecast.sh/install.ps1 | iex         (Windows)"
