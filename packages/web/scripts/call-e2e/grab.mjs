#!/usr/bin/env node
// Grabs frames of a live track the way another person in the room receives
// them, so a test can see what actually crossed the media server: the pixels
// after the encoder and the SFU, not the ones publish.mjs painted. When the
// frame carries a timecode strip it is decoded, and the frame's age (from
// being painted to being read here) is printed. The age includes this
// machine's own decode and queueing, so on a loaded machine it measures the
// machine as much as the network.
//
//   node grab.mjs <room> [--source screen_share] [--from <identity>] [--count 1] [--every 1] [--out <dir>] [--json]
//
//   --source S     camera | screen_share (default screen_share)
//   --from ID      only that participant's track (default: the first one found)
//   --count N      frames to save (default 1)
//   --every S      seconds between saved frames (default 1)
//   --out DIR      where PNGs go (default $TMPDIR/codecast-call-e2e/grabs)
//   --timeout S    give up when no such track appears (default 60)
//   --json         one JSON object per frame: { path, identity, width, height, receivedAt, strip?, ageMs? }
//
// It joins hidden (the grant's `hidden` flag), publishes nothing and
// subscribes to the one track it reads, so nobody in the room sees it and the
// app's people rows do not count it.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// livekit.mjs first: it quiets the SDK logger before rtc-node loads.
import { die, loadLivekitEnv, parseArgs, participantToken } from "./livekit.mjs";
import { Room, RoomEvent, TrackSource, VideoBufferType, VideoStream, dispose } from "@livekit/rtc-node";
import { decodeStrips, grayOf, writePng } from "./frames.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2), { booleans: ["json", "refresh-env"] });
const room = positionals[0];
if (!room) die("usage: node grab.mjs <room> [--source screen_share|camera] [--from <identity>] [--count N] [--every S] [--out DIR] [--json]", 64);
const SOURCES = { camera: TrackSource.SOURCE_CAMERA, screen_share: TrackSource.SOURCE_SCREENSHARE };
const sourceKey = String(flags.source ?? "screen_share");
const wanted = SOURCES[sourceKey];
if (wanted === undefined) die(`--source must be one of ${Object.keys(SOURCES).join(", ")}`, 64);
const count = Math.max(1, Number(flags.count ?? 1));
const everyMs = Math.max(0, Number(flags.every ?? 1) * 1000);
const outDir = resolve(flags.out ?? join(tmpdir(), "codecast-call-e2e", "grabs"));
mkdirSync(outDir, { recursive: true });

const env = loadLivekitEnv({ refresh: Boolean(flags["refresh-env"]) });
const token = await participantToken(env, {
  room,
  identity: `call-e2e-grab:${process.pid}`,
  name: "call-e2e grab",
  ttlSeconds: 3600,
  grant: { roomJoin: true, canPublish: false, canPublishData: false, canSubscribe: true, hidden: true },
});
const lk = new Room();
const say = (line) => !flags.json && process.stderr.write(`${line}\n`);

const finish = async (code) => {
  await lk.disconnect().catch(() => {});
  await dispose().catch(() => {});
  process.exit(code);
};
const timer = setTimeout(() => {
  process.stderr.write(`No ${sourceKey} track${flags.from ? ` from ${flags.from}` : ""} in ${room} within ${flags.timeout ?? 60}s.\n`);
  finish(3);
}, Number(flags.timeout ?? 60) * 1000);

let reading = false;
async function read(track, participant) {
  reading = true;
  clearTimeout(timer);
  say(`reading ${sourceKey} from ${participant.name || participant.identity} (${participant.identity})`);
  let saved = 0;
  let nextAt = 0;
  for await (const { frame } of new VideoStream(track)) {
    const now = Date.now();
    if (now < nextAt) continue;
    const rgba = frame.convert(VideoBufferType.RGBA);
    const path = join(outDir, `${room.replace(/[^\w.-]+/g, "_")}-${sourceKey}-${now}.png`);
    writePng(path, rgba.data, rgba.width, rgba.height);
    const [strip] = decodeStrips(grayOf(rgba.data, rgba.width, rgba.height), rgba.width, rgba.height);
    const row = {
      path,
      identity: participant.identity,
      width: rgba.width,
      height: rgba.height,
      receivedAt: new Date(now).toISOString(),
      ...(strip ? { strip: { ...strip, capturedAt: new Date(strip.capturedAtMs).toISOString() }, ageMs: now - strip.capturedAtMs } : {}),
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(row)}\n`);
    else
      process.stdout.write(
        `${path}  ${rgba.width}x${rgba.height}${strip ? `  frame ${strip.frame}  painted ${row.strip.capturedAt}  age ${row.ageMs} ms` : "  (no timecode strip)"}\n`,
      );
    if (++saved >= count) return finish(0);
    nextAt = now + everyMs;
  }
  die("The track ended before every frame was saved.");
}

const matches = (pub, p) => pub.source === wanted && (!flags.from || p.identity === flags.from);
lk.on(RoomEvent.TrackPublished, (pub, p) => {
  if (!reading && matches(pub, p)) pub.setSubscribed(true);
});
lk.on(RoomEvent.TrackSubscribed, (track, pub, p) => {
  if (!reading && matches(pub, p)) read(track, p);
});

say(`joining ${room} hidden...`);
await lk.connect(env.LIVEKIT_URL, token, { autoSubscribe: false, dynacast: false });
for (const p of lk.remoteParticipants.values()) {
  for (const pub of p.trackPublications.values()) {
    if (!reading && matches(pub, p)) {
      pub.setSubscribed(true);
      break;
    }
  }
}
