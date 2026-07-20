#!/bin/bash
# Render the remaining demos (2,4,5) and refresh every share copy from its master.
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

render() {
  local n="$1" name="$2"
  if [ -f "renders/${name}.mp4" ] && [ "renders/${name}.mp4" -nt studio.mjs ]; then
    echo "SKIP demo$n (fresh master exists)"; return
  fi
  echo "=== rendering demo$n -> renders/${name}.mp4 ==="
  npx hyperframes render -c "compositions/demo$n.html" --quality high --skill=product-launch-video -o "renders/${name}.mp4" 2>&1 | tail -2
}

render 1 "01-inbox"
render 2 "02-messaging"
render 3 "03-fork-spawn"
render 4 "04-tasks-plans"
render 5 "05-triggers-workflows"

echo "=== compressing share copies ==="
mkdir -p renders/share
for name in "01-inbox" "02-messaging" "03-fork-spawn" "04-tasks-plans" "05-triggers-workflows"; do
  if [ -f "renders/${name}.mp4" ]; then
    ffmpeg -y -i "renders/${name}.mp4" -c:v libx264 -crf 25 -preset slow -pix_fmt yuv420p \
      -c:a aac -b:a 128k -movflags +faststart "renders/share/${name}.mp4" 2>/dev/null
    echo "   share/${name}.mp4 $(ls -lh renders/share/${name}.mp4 | awk '{print $5}')"
  else
    echo "   MISSING master: renders/${name}.mp4"
  fi
done
echo "ALL DONE"
