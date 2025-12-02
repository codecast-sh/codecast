#!/bin/bash
# Quick health check for code-chat-sync development environment
# Should complete in <10 seconds
# Returns 0 if environment is healthy, 1 otherwise

set -e

echo "Running quick health checks..."

# Check node_modules exist
if [ ! -d "node_modules" ]; then
    echo "FAIL: node_modules not found. Run ./init.sh first."
    exit 1
fi

# Check packages exist
if [ ! -d "packages/cli" ]; then
    echo "FAIL: packages/cli not found"
    exit 1
fi

if [ ! -d "packages/web" ]; then
    echo "FAIL: packages/web not found"
    exit 1
fi

if [ ! -d "packages/convex" ]; then
    echo "FAIL: packages/convex not found"
    exit 1
fi

# Check package dependencies installed
if [ ! -d "packages/cli/node_modules" ] && [ ! -f "packages/cli/package.json" ]; then
    echo "FAIL: CLI package not set up"
    exit 1
fi

echo "Health check passed"
exit 0
