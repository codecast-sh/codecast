#!/bin/bash
# Generates assets/icon.ico (the Windows app, installer and shortcut icon) from
# assets/icon.png. Rerun after changing icon.png and commit both.
#
# Reproducible: the same icon.png gives the same bytes. ImageMagick stamps
# date chunks into each PNG-compressed frame unless told not to, which would
# change the file on every run.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=assets/icon.png
OUT=assets/icon.ico

command -v magick >/dev/null || { echo "make-icon-ico: needs ImageMagick 7 (brew install imagemagick)" >&2; exit 1; }

# Windows picks the frame nearest each use: 16/24/32 for lists and the tray,
# 48 for the desktop, 256 for large icons and the installer.
magick "$SRC" -background none \
  -define png:exclude-chunks=date,time,tIME \
  -define icon:auto-resize=256,128,64,48,32,24,16 \
  +set date:create +set date:modify \
  "$OUT"
echo "make-icon-ico: wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
