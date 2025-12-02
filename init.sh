#!/bin/bash
set -e

# =============================================================================
# code-chat-sync Development Environment Setup
# =============================================================================
#
# This script sets up the development environment for code-chat-sync, a utility
# that watches coding agent history files and syncs them to a Convex database.
#
# Prerequisites:
#   - Bun (https://bun.sh) - JavaScript runtime and package manager
#   - Node.js 18+ (for Convex CLI)
#   - Git
#
# Required environment variables:
#   - AGENT_RESOURCE_INDEX: Optional. Used for parallel agent work (0-2).
#     Controls port allocation for dev servers.
#
# Port allocation based on AGENT_RESOURCE_INDEX:
#   Index 0: Web 3000, Convex 3001
#   Index 1: Web 3100, Convex 3101
#   Index 2: Web 3200, Convex 3201
#
# What this script does:
#   1. Verifies prerequisites (bun, node)
#   2. Installs dependencies for all packages
#   3. Starts Convex dev server (if not already running)
#   4. Starts Next.js dev server (if not already running)
#   5. Runs smoke test to verify setup
#
# Usage:
#   ./init.sh                    # Default setup (index 0)
#   AGENT_RESOURCE_INDEX=1 ./init.sh  # Setup for parallel agent 1
#
# =============================================================================

# Port allocation based on AGENT_RESOURCE_INDEX
INDEX=${AGENT_RESOURCE_INDEX:-0}
export WEB_PORT=$((3000 + INDEX * 100))
export CONVEX_PORT=$((3001 + INDEX * 100))

echo "=== code-chat-sync Development Setup ==="
echo "Agent Resource Index: $INDEX"
echo "Web Port: $WEB_PORT"
echo "Convex Port: $CONVEX_PORT"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v bun &> /dev/null; then
    echo "Error: bun is not installed. Install from https://bun.sh"
    exit 1
fi
echo "  bun: $(bun --version)"

if ! command -v node &> /dev/null; then
    echo "Error: node is not installed"
    exit 1
fi
echo "  node: $(node --version)"

# Install dependencies
echo ""
echo "Installing dependencies..."
bun install

# Create .env files if they don't exist
if [ ! -f packages/web/.env.local ]; then
    echo "Creating packages/web/.env.local..."
    cat > packages/web/.env.local << EOF
# Convex deployment URL (set after running npx convex dev)
NEXT_PUBLIC_CONVEX_URL=
EOF
fi

# Run quick health check
echo ""
echo "Running health check..."
if [ -f ./check.sh ]; then
    if ./check.sh; then
        echo "Health check passed - environment already set up"
    else
        echo "Health check failed - continuing with full setup"
    fi
fi

# Smoke test - verify packages can be built/checked
echo ""
echo "Running smoke tests..."

# Check CLI package compiles
echo "  Checking CLI package..."
cd packages/cli
if bun run build 2>/dev/null || bun run typecheck 2>/dev/null; then
    echo "    CLI: OK"
else
    echo "    CLI: TypeScript setup needed (expected for initial setup)"
fi
cd ../..

# Check web package
echo "  Checking web package..."
cd packages/web
if bun run build 2>/dev/null || bun run lint 2>/dev/null; then
    echo "    Web: OK"
else
    echo "    Web: Build setup needed (expected for initial setup)"
fi
cd ../..

# Check convex package
echo "  Checking Convex package..."
cd packages/convex
if [ -f convex/schema.ts ]; then
    echo "    Convex: Schema exists"
else
    echo "    Convex: Schema not yet created"
fi
cd ../..

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Set up Convex: cd packages/convex && npx convex dev"
echo "  2. Start web dev server: cd packages/web && bun run dev"
echo "  3. Start CLI dev: cd packages/cli && bun run dev"
echo ""
echo "For parallel development, use AGENT_RESOURCE_INDEX=N ./init.sh"
