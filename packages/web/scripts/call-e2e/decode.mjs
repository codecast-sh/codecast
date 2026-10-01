#!/usr/bin/env node
// Reads the timecode strip out of an image or a video frame made by
// publish.mjs, so a test can say exactly which captured frame a snapshot
// shows and how far it is from the moment that was asked for.
//
//   node decode.mjs <image | video | https url> [--at <seconds>] [--expect <iso | epoch ms>] [--json]
//   node decode.mjs <video | https url> --scan [--file-start <iso | epoch ms>] [--limit 600] [--json]
//
//   <image>         a PNG or JPEG, e.g. what `cast call snap` wrote
//   <video> --at S  seeks S seconds in first, with ffmpeg's -ss semantics:
//                   S counts from the container's start_time, which a
//                   LiveKit egress file does not always put at 0 (see --scan)
//   --expect T      the wall clock moment the frame should show; prints the
//                   difference (decoded capture time minus T) for each strip
//   --scan          decodes every frame of a video and prints its timestamp
//                   in the file (pts) beside the moment it was painted: the
//                   ground truth for how file time maps to wall time
//   --file-start T  with --scan, the file's wall clock start (an egress file
//                   result's started_at); adds the error of the rule
//                   "wall = file start + pts" for each frame
//   --json          --at/image: [{ source, capturedAtMs, capturedAt, frame, x, y, cellPx, deltaMs? }]
//                   --scan: { startTime, frames: [{ pts, strips, errorMs? }] }
//
// A frame can hold more than one strip (a room composite with the share and a
// camera tile both visible); each is listed, top to bottom. Exit 0 with at
// least one strip, 2 when none decodes (a frame with no synthetic publisher
// in it, or a tile too small to read: a strip needs cells about 3px wide).
// Needs ffmpeg and ffprobe on PATH.
import { execFileSync } from "node:child_process";
import { decodeStrips } from "./frames.mjs";
import { die, parseArgs } from "./livekit.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2), { booleans: ["json", "scan"] });
const input = positionals[0];
if (!input) die("usage: node decode.mjs <image | video | url> [--at <seconds>] [--expect <time>] [--scan [--file-start <time>]] [--json]", 64);

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], ...opts });
  } catch (err) {
    if (err.code === "ENOENT") die(`${cmd} is not installed. Install it with: brew install ffmpeg`);
    die(`${cmd} failed: ${String(err.stderr || err.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}
const probe = (entries, extra = []) =>
  String(run("ffprobe", ["-v", "error", "-select_streams", "v:0", ...extra, "-show_entries", entries, "-of", "csv=p=0", input], { encoding: "utf8" })).trim();

const parseTime = (key) => {
  if (flags[key] === undefined) return undefined;
  const v = String(flags[key]);
  // Epoch ms, or LiveKit's epoch nanoseconds, or an ISO time.
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (Number.isNaN(n)) die(`--${key} ${v} is neither an ISO time nor an epoch number`, 64);
  return n > 1e15 ? Math.round(n / 1e6) : n;
};

const [width, height] = probe("stream=width,height").split("\n")[0].split(",").map(Number);
if (!width || !height) die(`${input} has no video stream`);
const frameBytes = width * height;
const iso = (ms) => new Date(ms).toISOString();
const local = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false }) + `.${String(ms % 1000).padStart(3, "0")}`;

if (flags.scan) {
  const fileStart = parseTime("file-start");
  const limit = Number(flags.limit ?? 600);
  const startTime = Number(probe("stream=start_time").split("\n")[0]) || 0;
  const pts = probe("frame=pts_time", ["-read_intervals", `%+#${limit}`]).split("\n").filter(Boolean).map(Number);
  // passthrough keeps one output frame per decoded frame, so the raw frames
  // line up with the pts list.
  const raw = run("ffmpeg", ["-v", "error", "-i", input, "-frames:v", String(limit), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const frames = [];
  for (let i = 0; i * frameBytes + frameBytes <= raw.length && i < pts.length; i++) {
    const strips = decodeStrips(raw.subarray(i * frameBytes, (i + 1) * frameBytes), width, height);
    const errorMs = fileStart !== undefined && strips[0] ? strips[0].capturedAtMs - Math.round(fileStart + pts[i] * 1000) : undefined;
    frames.push({ pts: pts[i], strips, ...(errorMs !== undefined ? { errorMs } : {}) });
  }
  if (flags.json) process.stdout.write(`${JSON.stringify({ startTime, frames }, null, 2)}\n`);
  else {
    process.stdout.write(`${input}: ${frames.length} frames, ${width}x${height}, container start_time ${startTime}s\n`);
    for (const f of frames) {
      const s = f.strips[0];
      process.stdout.write(
        `  pts ${f.pts.toFixed(3).padStart(9)}  ${s ? `${s.source} frame ${String(s.frame).padStart(6)}  painted ${iso(s.capturedAtMs)} (local ${local(s.capturedAtMs)})` : "(no strip)"}${f.errorMs !== undefined ? `  wall-vs-rule ${f.errorMs >= 0 ? "+" : ""}${f.errorMs} ms` : ""}\n`,
      );
    }
  }
  process.exit(frames.some((f) => f.strips.length) ? 0 : 2);
}

const seek = flags.at !== undefined ? ["-ss", String(flags.at)] : [];
const gray = run("ffmpeg", ["-v", "error", ...seek, "-i", input, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
if (gray.length < frameBytes) die(`${input}: no frame at ${flags.at ?? 0}s`);

const expectMs = parseTime("expect");
const strips = decodeStrips(gray, width, height).map((s) => ({
  ...s,
  capturedAt: iso(s.capturedAtMs),
  ...(expectMs !== undefined ? { deltaMs: s.capturedAtMs - expectMs } : {}),
}));

if (flags.json) process.stdout.write(`${JSON.stringify(strips, null, 2)}\n`);
else if (!strips.length) process.stderr.write(`No timecode strip found in ${input} (${width}x${height}).\n`);
else {
  for (const s of strips) {
    const delta = s.deltaMs === undefined ? "" : `  delta ${s.deltaMs >= 0 ? "+" : ""}${s.deltaMs} ms`;
    process.stdout.write(
      `${s.source.padEnd(6)}  frame ${String(s.frame).padStart(6)}  captured ${s.capturedAt} (local ${local(s.capturedAtMs)})${delta}  at ${s.x},${s.y} cell ${s.cellPx}px\n`,
    );
  }
}
process.exit(strips.length ? 0 : 2);
