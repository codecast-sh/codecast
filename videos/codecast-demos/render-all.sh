#!/bin/bash
# Render demos 2-5 at high quality, then produce web-friendly share copies (<30MB).
set -e
cd "$(dirname "$0")"
names=( "" "01-inbox" "02-messaging" "03-fork-spawn" "04-tasks-plans" "05-triggers-workflows" )
for n in 2 3 4 5; do
  out="renders/${names[$n]}.mp4"
  echo "=== rendering demo$n → $out ==="
  npx hyperframes render -c "compositions/demo$n.html" --quality high --skill=product-launch-video -o "$out" 2>&1 | tail -3
  echo "=== compressing share/${names[$n]}.mp4 ==="
  ffmpeg -y -i "$out" -c:v libx264 -crf 25 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "renders/share/${names[$n]}.mp4" 2>/dev/null
  ls -lh "renders/share/${names[$n]}.mp4" | awk '{print "   share:", $5}'
done
echo "ALL DONE"
