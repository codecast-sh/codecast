#!/bin/bash
# One-time setup: adds hosts entries and installs nginx proxy
# Run with: sudo ./setup-hosts.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOSTS_FILE="/etc/hosts"
MARKER="# codecast dev domains"
PLIST_SRC="$SCRIPT_DIR/com.codecast.nginx.plist"
PLIST_DST="/Library/LaunchDaemons/com.codecast.nginx.plist"

# Add hosts entries
if ! grep -q "$MARKER" "$HOSTS_FILE"; then
    echo "Adding codecast dev domains to $HOSTS_FILE..."
    cat >> "$HOSTS_FILE" << 'EOF'

# codecast dev domains
127.0.0.1 local.codecast.sh
127.0.0.1 local.1.codecast.sh
127.0.0.1 local.2.codecast.sh
127.0.0.1 local.3.codecast.sh
EOF
else
    echo "Hosts entries already configured"
fi

# Install nginx launchd service
if [ ! -f "$PLIST_DST" ]; then
    echo "Installing nginx proxy service..."
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl load "$PLIST_DST"
else
    echo "Nginx service already installed, reloading..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl load "$PLIST_DST"
fi

echo ""
echo "Done. Nginx proxy runs on boot. You can now use:"
echo "  ./dev.sh     -> http://local.codecast.sh"
echo "  ./dev.sh 1   -> http://local.1.codecast.sh"
echo "  ./dev.sh 2   -> http://local.2.codecast.sh"
