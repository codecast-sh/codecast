#!/usr/bin/env node
// Reads the timecode strip out of an image or a video frame made by
// publish.mjs, so a test can say exactly which captured frame a snapshot
// shows and how far it is from the moment that was asked for.
//
//   node decode.mjs <image | video | https url> [--at <seconds>] [--expect <iso | epoch ms>] [--json]
//
//   <image>         a PNG or JPEG, e.g. what `cast call snap` wrote
//   <video> --at S  seeks S seconds into a recording first (ffmpeg -ss)
//   --expect T      the wall clock moment the frame should show; prints the
//                   difference (decoded capture time minus T) for each strip
//   --json          [{ source, capturedAtMs, capturedAt, frame, x, y, cellPx, deltaMs? }]
//
// A frame can hold more than one strip (a room composite with the share and a
// camera tile both visible); each is listed, top to bottom. Exit 0 with at
// least one strip, 2 when none decodes (a frame with no synthetic publisher
// in it, or a tile too small to read: a strip needs cells about 3px wide).
// Needs ffmpeg and ffprobe on PATH.
import { execFileSync } from "node:child_process";
import { decodeStrips } from "./frames.mjs";
import { die, parseArgs } from "./livekit.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2), { booleans: ["json"] });
const input = positionals[0];
if (!input) die("usage: node decode.mjs <image | video | url> [--at <seconds>] [--expect <iso | epoch ms>] [--json]", 64);

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
  } catch (err) {
    if (err.code === "ENOENT") die(`${cmd} is not installed. Install it with: brew install ffmpeg`);
    die(`${cmd} failed: ${String(err.stderr || err.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}

const seek = flags.at !== undefined ? ["-ss", String(flags.at)] : [];
const [width, height] = String(
  run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", input], {
    encoding: "utf8",
  }),
)
  .trim()
  .split(",")
  .map(Number);
if (!width || !height) die(`${input} has no video stream`);

const gray = run("ffmpeg", ["-v", "error", ...seek, "-i", input, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
if (gray.length < width * height) die(`${input}: no frame at ${flags.at ?? 0}s`);

const expectMs =
  flags.expect === undefined ? undefined : /^\d+$/.test(flags.expect) ? Number(flags.expect) : Date.parse(flags.expect);
if (Number.isNaN(expectMs)) die(`--expect ${flags.expect} is neither an ISO time nor epoch ms`, 64);

const strips = decodeStrips(gray, width, height).map((s) => ({
  ...s,
  capturedAt: new Date(s.capturedAtMs).toISOString(),
  ...(expectMs !== undefined ? { deltaMs: s.capturedAtMs - expectMs } : {}),
}));

if (flags.json) process.stdout.write(`${JSON.stringify(strips, null, 2)}\n`);
else if (!strips.length) process.stderr.write(`No timecode strip found in ${input} (${width}x${height}).\n`);
else {
  for (const s of strips) {
    const local = new Date(s.capturedAtMs).toLocaleTimeString("en-GB", { hour12: false }) + `.${String(s.capturedAtMs % 1000).padStart(3, "0")}`;
    const delta = s.deltaMs === undefined ? "" : `  delta ${s.deltaMs >= 0 ? "+" : ""}${s.deltaMs} ms`;
    process.stdout.write(
      `${s.source.padEnd(6)}  frame ${String(s.frame).padStart(6)}  captured ${s.capturedAt} (local ${local})${delta}  at ${s.x},${s.y} cell ${s.cellPx}px\n`,
    );
  }
}
process.exit(strips.length ? 0 : 2);
