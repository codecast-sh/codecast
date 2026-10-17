#!/bin/bash
# Cuts film.sh's takes into the App Store preview: out/preview-iphone.mp4,
# 886x1920 (the 6.5"/6.9" iPhone preview size), 30 fps H.264, a silent stereo
# AAC track (App Store Connect refuses a preview with no audio track), each
# take trimmed to its action and joined with short crossfades.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
# take: start-trim end-trim (seconds), so each take opens on settled UI. A
# negative end-trim holds the take's last frame that much longer: under load
# the app answers a tap in the take's final moment.
TRIMS=("1.0 0.2" "0.4 -1.6" "0.6 -1.4" "0.5 0.2" "1.4 0.1")
FADE=0.35
python3 - "$FADE" "${TRIMS[@]}" <<'PY' > /tmp/preview-cmd.sh
import subprocess, sys
fade = float(sys.argv[1]); trims = [tuple(map(float, t.split())) for t in sys.argv[2:]]
ins, chains, lens = [], [], []
for i, (a, b) in enumerate(trims, 1):
    d = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f"raw/take-{i}.mov"]))
    lens.append(d - a - b)
    ins += ["-i", f"raw/take-{i}.mov"]
    # The simulator writes a frame only when the screen changes, so a still
    # take is a handful of frames. Hold the last real frame first (fps drops
    # the final frames at end of stream, and under load that is where a tap
    # lands), then resample to a constant 30 fps for the trim and the fades.
    chains.append(f"[{i-1}:v]tpad=stop_mode=clone:stop_duration=3,fps=30,trim={a}:{d-b},setpts=PTS-STARTPTS,scale=886:-2,crop=886:1920,format=yuv420p,settb=AVTB[v{i}]")
prev, t = "v1", lens[0]
for i in range(2, len(trims) + 1):
    t -= fade
    chains.append(f"[{prev}][v{i}]xfade=transition=fade:duration={fade}:offset={t:.3f}[x{i}]")
    prev, t = f"x{i}", t + lens[i-1]
total = t
graph = ";".join(chains)
print("ffmpeg -v error -y " + " ".join(ins) +
      f" -f lavfi -t {total:.3f} -i anullsrc=channel_layout=stereo:sample_rate=44100"
      f" -filter_complex '{graph}' -map '[{prev}]' -map {len(trims)}:a"
      " -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p -r 30 -b:v 10M -maxrate 12M -bufsize 20M"
      " -c:a aac -b:a 128k -shortest -movflags +faststart out/preview-iphone.mp4")
print(f"echo 'preview length {total:.1f}s'", )
PY
bash /tmp/preview-cmd.sh
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration -of compact out/preview-iphone.mp4
