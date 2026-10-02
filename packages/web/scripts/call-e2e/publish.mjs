#!/usr/bin/env node
// A synthetic call participant: joins a LiveKit room the way a person's
// browser does and publishes a camera, a screen share and optionally a tone,
// all generated, so recordings, track egress, frame snapshots and guest
// presence can be tested end to end with no camera, no screen picker and no
// human in the loop.
//
// Usage (from packages/web/scripts/call-e2e, after `npm install` here once):
//
//   node publish.mjs <room> [identity] [media] [timing]
//
//   <room>                 the LiveKit room name. A huddle's is its room key,
//                          e.g. session:<conversationId>, dm:<userA>,<userB> or
//                          channel:<channelId> (packages/shared/contracts/
//                          callRoomKeys.ts). Any other name is a scratch room
//                          nobody's app will show, which is what a smoke test
//                          wants.
//
//   identity (pick one; default identity call-e2e:<random>):
//   --member <userId>      join as that codecast user (identity = the user id,
//                          exactly what calls.mintAccessToken signs)
//   --guest[=<guestId>]    join as an outside guest (identity guest:<guestId>,
//                          a fresh random id when no id is given)
//   --identity <raw>       any identity string
//   --name <text>          display name (default "Call E2E" / "Guest <id>")
//   --image <url>          avatar, sent as metadata {"image": url} like a member
//   --metadata <json>      raw participant metadata (overrides --image)
//
//   media:
//   --no-camera            skip the camera track
//   --no-screen            skip the screen share track
//   --tone                 publish a microphone track: an 880 Hz pip at every
//                          wall clock second and a 1320 Hz pip at every scene cut
//   --speak <s>            publish a microphone track that says a numbered line
//                          every <s> seconds ("Marker 3. This is line 3 of
//                          the recording test."), spoken by macOS `say`, so
//                          the scribe writes transcript lines to snap at.
//                          Each line logs the wall time it began.
//                          Takes the place of --tone.
//   --screen-size WxH      share resolution (default 1920x1080)
//   --screen-fps N         share frame rate (default 10)
//   --camera-size WxH      camera resolution (default 960x540)
//   --camera-fps N         camera frame rate (default 15)
//
//   timing:
//   --duration <s>         leave after this long (default: until Ctrl-C)
//   --screen-at <s>        start the share this long after joining (default 0)
//   --screen-for <s>       stop the share after this long, and stay in the room
//
//   --preview <dir>        write one PNG of each slide to <dir> and exit,
//                          without connecting (needs ffmpeg)
//   --refresh-env          re-read LIVEKIT_* from the Convex env (livekit.mjs)
//
// What the frames carry (frames.mjs has the details):
//   screen  a full slide whose color is the scene, cutting every 10 s on the
//           wall clock (at :00, :10, :20 ... of every minute, for every
//           publisher), with the local time to the tenth in large type, UTC
//           and the date, the frame counter, time since the share began, a
//           ten box second meter, and a timecode strip along the bottom
//   camera  initials on a color tile, a square orbiting every 2 s, the clock,
//           the frame counter and the strip
// decode.mjs reads the strip back out of a PNG or a recording, which is how
// a test proves which frame a snapshot holds.
//
// The token is signed locally with the server secret (livekit.mjs), so this
// joins any room without the app's authorization; that is the point of a
// harness, and why the secret never leaves the 0600 cache. A real member's
// identity here really does look like that member to everyone in the room.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
// livekit.mjs first: it quiets the SDK logger before rtc-node loads.
import { die, loadLivekitEnv, parseArgs, participantToken } from "./livekit.mjs";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  dispose,
} from "@livekit/rtc-node";
import { Canvas, identityColor, paintCamera, paintScreen, SCENE_MS, sceneAt, writePng } from "./frames.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2), {
  booleans: ["no-camera", "no-screen", "tone", "refresh-env", "guest"],
});

const size = (s, dflt) => {
  const m = /^(\d+)x(\d+)$/.exec(s ?? dflt);
  if (!m) die(`size must look like 1920x1080, got ${s}`, 64);
  // I420 conversion needs even dimensions.
  return { width: Number(m[1]) & ~1, height: Number(m[2]) & ~1 };
};
const num = (key, dflt) => {
  if (flags[key] === undefined) return dflt;
  const n = Number(flags[key]);
  if (!Number.isFinite(n) || n < 0) die(`--${key} must be a non negative number`, 64);
  return n;
};

// `--guest` alone mints a random guest id; `--guest=<id>` names one.
const isGuest = Boolean(flags.guest);
const gid = isGuest ? (flags.guest === true ? randomUUID().slice(0, 8) : flags.guest) : undefined;
const room = positionals[0];
if (!room && !flags.preview) die("usage: node publish.mjs <room> [--member <userId> | --guest[=<id>] | --identity <id>] [--name <n>] [--tone] [--duration <s>] ...  (header of publish.mjs has the rest)", 64);
if ([flags.member, isGuest || undefined, flags.identity].filter(Boolean).length > 1) die("pick one of --member, --guest, --identity", 64);

const identity = flags.member ?? (isGuest ? `guest:${gid}` : flags.identity ?? `call-e2e:${randomUUID().slice(0, 6)}`);
const name = flags.name ?? (isGuest ? `Guest ${gid}` : "Call E2E");
const metadata = flags.metadata ?? (flags.image ? JSON.stringify({ image: flags.image }) : undefined);
const screenSize = size(flags["screen-size"], "1920x1080");
const cameraSize = size(flags["camera-size"], "960x540");
const screenFps = num("screen-fps", 10) || 10;
const cameraFps = num("camera-fps", 15) || 15;
const color = identityColor(identity);
const label = name.toUpperCase().slice(0, 28);

// ── Preview: the slides as PNGs, no network ───────────────────────────────
if (flags.preview) {
  const dir = resolve(flags.preview);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const slides = [
    ["screen", screenSize, (c) => paintScreen(c, { nowMs: now, frame: 421, startedAtMs: now - 42_300, label })],
    ["camera", cameraSize, (c) => paintCamera(c, { nowMs: now, frame: 631, name, colorHex: color })],
  ];
  for (const [kind, { width, height }, paint] of slides) {
    const c = new Canvas(width, height);
    paint(c);
    process.stdout.write(`${writePng(join(dir, `${kind}.png`), c.data, width, height)}\n`);
  }
  process.exit(0);
}

// ── Media loops ───────────────────────────────────────────────────────────
// Each video loop paints from the wall clock at capture time, so what a frame
// says is when it was handed to the encoder. Ticks are scheduled against an
// absolute deadline so a slow paint delays one frame instead of every later one.
function videoLoop({ width, height, fps, paint }) {
  const source = new VideoSource(width, height);
  const canvas = new Canvas(width, height);
  const frame = new VideoFrame(canvas.data, width, height, VideoBufferType.RGBA);
  const state = { source, frames: 0, startedAtMs: Date.now(), timer: undefined, stopped: false };
  const period = 1000 / fps;
  const tick = () => {
    if (state.stopped) return;
    const now = Date.now();
    paint(canvas, { nowMs: now, frame: state.frames, startedAtMs: state.startedAtMs });
    source.captureFrame(frame);
    state.frames++;
    const next = state.startedAtMs + state.frames * period;
    state.timer = setTimeout(tick, Math.max(0, next - Date.now()));
  };
  state.start = () => {
    state.startedAtMs = Date.now();
    tick();
  };
  state.stop = async () => {
    state.stopped = true;
    clearTimeout(state.timer);
    await source.close().catch(() => {});
  };
  return state;
}

const SAMPLE_RATE = 48_000;
const AUDIO_FRAME = 960; // 20 ms
function toneLoop() {
  const source = new AudioSource(SAMPLE_RATE, 1, 100);
  const state = { source, stopped: false };
  state.start = async () => {
    const t0 = Date.now();
    let sample = 0;
    while (!state.stopped) {
      const pcm = new Int16Array(AUDIO_FRAME);
      for (let i = 0; i < AUDIO_FRAME; i++) {
        const tMs = t0 + ((sample + i) * 1000) / SAMPLE_RATE;
        const inSecond = tMs % 1000;
        if (inSecond < 120) {
          const cut = tMs % SCENE_MS < 1000;
          const hz = cut ? 1320 : 880;
          // A short raised cosine envelope keeps the pip from clicking.
          const env = Math.sin((Math.PI * inSecond) / 120);
          pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * (sample + i)) / SAMPLE_RATE) * env * 9000);
        }
      }
      sample += AUDIO_FRAME;
      await source.captureFrame(new AudioFrame(pcm, SAMPLE_RATE, 1, AUDIO_FRAME));
    }
  };
  state.stop = async () => {
    state.stopped = true;
    await source.close().catch(() => {});
  };
  return state;
}

// Speech: each line is rendered by `say` and decoded to 48 kHz mono PCM by
// ffmpeg just before it is spoken, so it can name the scene showing at that
// moment. Silence fills the gaps (a track that stops sending looks muted).
function speechLoop(everyS) {
  const source = new AudioSource(SAMPLE_RATE, 1, 100);
  const state = { source, stopped: false, lines: 0 };
  const dir = mkdtempSync(join(tmpdir(), "call-e2e-speak-"));
  // Rendered off the event loop, one line ahead: a synchronous `say` on a
  // loaded machine takes seconds and would stall every video loop with it.
  const render = async (n) => {
    const aiff = join(dir, `line-${n}.aiff`);
    const text = `Marker ${n}. This is line ${n} of the recording test.`;
    await run("say", ["-o", aiff, text]);
    const { stdout } = await run("ffmpeg", ["-v", "error", "-i", aiff, "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
    return { text, pcm: new Int16Array(stdout.buffer, stdout.byteOffset, stdout.byteLength >> 1) };
  };
  state.start = async () => {
    let next = Date.now() + 2000;
    let upcoming = render(1).catch((err) => (log(`speak failed: ${err.message}`), null));
    let ready = null;
    upcoming.then((r) => (ready = r));
    let pcm = null;
    let at = 0;
    while (!state.stopped) {
      const frame = new Int16Array(AUDIO_FRAME);
      if (!pcm && ready && Date.now() >= next) {
        state.lines++;
        pcm = ready.pcm;
        at = 0;
        log(`speak ${state.lines} at ${new Date().toISOString()}: "${ready.text}"`);
        ready = null;
        next = Date.now() + everyS * 1000;
        upcoming = render(state.lines + 1).catch((err) => (log(`speak failed: ${err.message}`), null));
        upcoming.then((r) => (ready = r));
      }
      if (pcm) {
        frame.set(pcm.subarray(at, at + AUDIO_FRAME));
        at += AUDIO_FRAME;
        if (at >= pcm.length) pcm = null;
      }
      await source.captureFrame(new AudioFrame(frame, SAMPLE_RATE, 1, AUDIO_FRAME));
    }
  };
  state.stop = async () => {
    state.stopped = true;
    rmSync(dir, { recursive: true, force: true });
    await source.close().catch(() => {});
  };
  return state;
}

// ── Join and publish ──────────────────────────────────────────────────────
const env = loadLivekitEnv({ refresh: Boolean(flags["refresh-env"]) });
const token = await participantToken(env, { room, identity, name, metadata });
const lk = new Room();
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (line) => process.stdout.write(`${stamp()}  ${line}\n`);

let leaving = false;
const loops = [];
async function leave(code = 0, why = "") {
  if (leaving) return;
  leaving = true;
  if (why) log(why);
  for (const l of loops) await l.stop();
  await lk.disconnect().catch(() => {});
  await dispose().catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => leave(0, "Interrupted; leaving the room."));
process.on("SIGTERM", () => leave(0, "Terminated; leaving the room."));

lk.on(RoomEvent.Disconnected, (reason) => {
  if (!leaving) leave(1, `Disconnected by the server (reason ${reason}).`);
});
lk.on(RoomEvent.ParticipantConnected, (p) => log(`joined: ${p.name || p.identity} (${p.identity})`));
lk.on(RoomEvent.ParticipantDisconnected, (p) => log(`left: ${p.name || p.identity} (${p.identity})`));

log(`joining ${room} as ${name} (${identity})...`);
try {
  await lk.connect(env.LIVEKIT_URL, token, { autoSubscribe: false, dynacast: false });
} catch (err) {
  die(`Could not join ${room}: ${err.message}`);
}
log(`in ${room} as ${name} (${identity}) on ${env.LIVEKIT_URL}`);
const others = [...lk.remoteParticipants.values()];
log(others.length ? `already here: ${others.map((p) => `${p.name || p.identity} (${p.identity})`).join(", ")}` : "the room was empty");

async function publish(kind, loop, track, options) {
  const pub = await lk.localParticipant.publishTrack(track, new TrackPublishOptions(options));
  loops.push(loop);
  loop.start();
  log(`published ${kind} ${pub.sid}${loop.source.width ? ` ${loop.source.width}x${loop.source.height}` : ""}`);
  return pub;
}

if (!flags["no-camera"]) {
  const cam = videoLoop({
    ...cameraSize,
    fps: cameraFps,
    paint: (c, f) => paintCamera(c, { ...f, name, colorHex: color }),
  });
  await publish("camera", cam, LocalVideoTrack.createVideoTrack("camera", cam.source), {
    source: TrackSource.SOURCE_CAMERA,
    simulcast: false,
    videoEncoding: { maxBitrate: 1_500_000n, maxFramerate: cameraFps },
  });
}

if (flags.speak !== undefined) {
  const speech = speechLoop(num("speak", 12) || 12);
  await publish("microphone (speech)", speech, LocalAudioTrack.createAudioTrack("microphone", speech.source), {
    source: TrackSource.SOURCE_MICROPHONE,
  });
} else if (flags.tone) {
  const tone = toneLoop();
  await publish("microphone (tone)", tone, LocalAudioTrack.createAudioTrack("microphone", tone.source), {
    source: TrackSource.SOURCE_MICROPHONE,
  });
}

if (!flags["no-screen"]) {
  const startShare = async () => {
    if (leaving) return;
    const share = videoLoop({ ...screenSize, fps: screenFps, paint: (c, f) => paintScreen(c, { ...f, label }) });
    const pub = await publish("screen share", share, LocalVideoTrack.createVideoTrack("screen", share.source), {
      source: TrackSource.SOURCE_SCREENSHARE,
      simulcast: false,
      videoEncoding: { maxBitrate: 4_000_000n, maxFramerate: screenFps },
    });
    const forS = num("screen-for", 0);
    if (forS > 0) {
      setTimeout(async () => {
        if (leaving) return;
        loops.splice(loops.indexOf(share), 1);
        await lk.localParticipant.unpublishTrack(pub.sid).catch(() => {});
        await share.stop();
        log(`stopped the screen share after ${forS}s (${share.frames} frames)`);
      }, forS * 1000);
    }
  };
  const at = num("screen-at", 0);
  if (at > 0) {
    log(`screen share starts in ${at}s`);
    setTimeout(startShare, at * 1000);
  } else await startShare();
}

// One line per scene cut, so a test can line up what it sampled against the
// cut it should have found.
let lastScene = sceneAt(Date.now()).index;
setInterval(() => {
  const s = sceneAt(Date.now());
  if (s.index === lastScene) return;
  lastScene = s.index;
  const counts = loops.filter((l) => l.frames !== undefined).map((l) => `${l.source.width}x${l.source.height}:${l.frames}`);
  log(`scene ${s.index % 1000} ${s.name} at ${new Date(s.index * SCENE_MS).toISOString()}  frames ${counts.join(" ") || "-"}`);
}, 250);

const duration = num("duration", 0);
if (duration > 0) setTimeout(() => leave(0, `Leaving after ${duration}s.`), duration * 1000);
else log("Ctrl-C to leave.");
