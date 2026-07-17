#!/bin/bash
# Render demos 1,2,4,5 at high quality (demo3 renders separately), then produce
# web-friendly share copies (<30MB) for all five.
cd "$(dirname "$0")"
render() {
  local n="$1" name="$2"
  local out="renders/${name}.mp4"
  echo "=== rendering demo$n → $out ==="
  npx hyperframes render -c "compositions/demo$n.html" --quality high --skill=product-launch-video -o "$out" 2>&1 | tail -2
}
render 1 "01-inbox"
render 2 "02-messaging"
render 4 "04-tasks-plans"
render 5 "05-triggers-workflows"
# wait for demo3's separate render to land, then compress everything
echo "=== compressing share copies ==="
mkdir -p renders/share
for pair in "01-inbox" "02-messaging" "03-fork-spawn" "04-tasks-plans" "05-triggers-workflows"; do
  tries=0
  while [ ! -f "renders/${pair}.mp4" ] && [ $tries -lt 60 ]; do sleep 10; tries=$((tries+1)); done
  if [ -f "renders/${pair}.mp4" ]; then
    ffmpeg -y -i "renders/${pair}.mp4" -c:v libx264 -crf 25 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "renders/share/${pair}.mp4" 2>/dev/null
    echo "   share/${pair}.mp4 $(ls -lh renders/share/${pair}.mp4 | awk '{print $5}')"
  else
    echo "   MISSING master: renders/${pair}.mp4"
  fi
done
echo "ALL DONE"
