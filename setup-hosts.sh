#!/bin/bash
# One-time setup for the local.*.codecast.sh dev names: adds the /etc/hosts
# entries and installs a launchd service that runs nginx with nginx.dev.conf.
# Needs nginx already installed (brew install nginx). macOS only.
# Run with: sudo ./setup-hosts.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOSTS_FILE="/etc/hosts"
MARKER="# codecast dev domains"
NGINX_CONF="$SCRIPT_DIR/nginx.dev.conf"
PLIST_DST="/Library/LaunchDaemons/com.codecast.nginx.plist"

# Everything that can fail is checked before anything is changed.
if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo: sudo ./setup-hosts.sh" >&2
    exit 1
fi
# sudo resets PATH, so look where Homebrew puts nginx as well.
NGINX_BIN="$(PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" command -v nginx || true)"
if [ -z "$NGINX_BIN" ]; then
    echo "nginx not found. Install it first: brew install nginx" >&2
    exit 1
fi

# nginx.dev.conf is local (gitignored); start it from the tracked example.
if [ ! -f "$NGINX_CONF" ]; then
    cp "$SCRIPT_DIR/nginx.dev.conf.example" "$NGINX_CONF"
    [ -n "${SUDO_USER:-}" ] && chown "$SUDO_USER" "$NGINX_CONF"
    echo "Created $NGINX_CONF from nginx.dev.conf.example"
fi
"$NGINX_BIN" -t -c "$NGINX_CONF"

# Add hosts entries
if ! grep -q "$MARKER" "$HOSTS_FILE"; then
    echo "Adding codecast dev domains to $HOSTS_FILE..."
    cat >> "$HOSTS_FILE" << 'HOSTS'

# codecast dev domains
127.0.0.1 local.codecast.sh
127.0.0.1 local.1.codecast.sh
127.0.0.1 local.2.codecast.sh
127.0.0.1 local.3.codecast.sh
HOSTS
else
    echo "Hosts entries already configured"
fi

# Install (or reinstall) the nginx launchd service
if [ -f "$PLIST_DST" ]; then
    echo "Nginx service already installed, reloading..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
else
    echo "Installing nginx proxy service..."
fi
cat > "$PLIST_DST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codecast.nginx</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NGINX_BIN</string>
        <string>-c</string>
        <string>$NGINX_CONF</string>
        <string>-g</string>
        <string>daemon off;</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
PLIST
chmod 644 "$PLIST_DST"
launchctl load "$PLIST_DST"

echo ""
echo "Done. Nginx proxy runs on boot. You can now use:"
echo "  ./dev.sh     -> http://local.codecast.sh"
echo "  ./dev.sh 1   -> http://local.1.codecast.sh"
echo "  ./dev.sh 2   -> http://local.2.codecast.sh"
echo "For https (the desktop app needs it), see the TLS block in nginx.dev.conf.example."
