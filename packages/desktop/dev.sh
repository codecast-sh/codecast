#!/bin/bash
set -e
cd "$(dirname "$0")"
exec npx @tauri-apps/cli@2 dev "$@"
