/**
 * `cast browser flight`: a rolling video of the session's tab, kept in memory
 * and written out only when asked.
 *
 * `flight start` launches a recorder process that outlives the command (every
 * `cast browser` call is a fresh process, so a buffer needs one that is not).
 * It attaches to the tab over CDP, through the extension bridge in the
 * human's Chrome or straight to the agent browser, and keeps the screencast's
 * JPEG frames in a ring bounded by time (60 s default, 120 s max), bytes
 * (128 MB) and count. `flight save` asks it for the last N seconds, which it
 * encodes with ffmpeg into an mp4 beside a poster frame; `flight stop` ends
 * it. Commands reach the recorder over a 0600 unix socket keyed to the
 * session, so one session's recorder is never another's.
 *
 * Chrome paints a background tab rarely or never, and a screencast sends a
 * frame only on a paint. When no frame has come for a while the recorder
 * takes screenshots instead, and drops one that repeats the last. A page that
 * did not change holds its last frame, so a save always covers the time asked.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { codecastPath } from "../codecastDir.js";
import { resolveCastInvocation } from "../castInvocation.js";
import { spawn } from "../proc.js";
import { CdpConnection, type CdpClient } from "./cdp.js";
import { imageSize } from "./shotFile.js";
import type { Command } from "commander";
import type { PublishDeps } from "../castApi.js";
import { fmt, icons } from "../colors.js";
import { fail } from "../externalDataCli.js";
import { inlineImageMarker } from "../inlineImage.js";
import { publishOnce } from "../publish.js";
import { agentTempPath } from "../tempFiles.js";
import { targetFlags } from "./bridge/commands.js";
import type { TargetChoice } from "./cliEngine.js";
import { ownerKey } from "./owner.js";
import { formatBytes } from "./profile.js";
import { openSessionTab, type SessionTab } from "./sessionTab.js";

export const FLIGHT_DEFAULT_SECONDS = 60;
export const FLIGHT_MAX_SECONDS = 120;
export const FLIGHT_SAVE_DEFAULT_SECONDS = 30;
export const FLIGHT_MAX_BYTES = 128 * 1024 * 1024;
export const FLIGHT_MAX_FRAMES = 7_200;
/** A recorder nobody stopped ends on its own after this. */
export const FLIGHT_MAX_LIFETIME_MS = 4 * 60 * 60_000;
/** No screencast frame for this long: fall back to screenshots. */
const SCREENCAST_QUIET_MS = 1_500;
const SCREENSHOT_EVERY_MS = 500;

export interface Frame {
  data: Buffer;
  /** Epoch ms it arrived. */
  at: number;
}

/**
 * The rolling buffer. Frames older than the retention go, except the newest
 * of them, which is what the screen showed when the window opens; then the
 * oldest go until the bytes and the count fit.
 */
export class FrameRing {
  readonly frames: Frame[] = [];
  bytes = 0;
  received = 0;
  dropped = 0;

  constructor(readonly retentionMs: number, readonly maxBytes = FLIGHT_MAX_BYTES, readonly maxFrames = FLIGHT_MAX_FRAMES) {}

  push(f: Frame): void {
    this.received++;
    this.frames.push(f);
    this.bytes += f.data.length;
    const cutoff = f.at - this.retentionMs;
    while (this.frames.length > 1 && this.frames[1].at <= cutoff) this.evict();
    while (this.frames.length > 1 && (this.bytes > this.maxBytes || this.frames.length > this.maxFrames)) {
      this.evict();
      this.dropped++;
    }
  }

  private evict(): void {
    this.bytes -= this.frames.shift()!.data.length;
  }

  get last(): Frame | undefined {
    return this.frames.at(-1);
  }

  /** The covered span: from the oldest frame (or the retention edge) to `now`. */
  coveredMs(now: number): number {
    if (!this.frames.length) return 0;
    return now - Math.max(this.frames[0].at, now - this.retentionMs);
  }

  /** The frames of the last `ms` before `now`, each with how long it stays on screen in that window. */
  window(ms: number, now: number): Array<{ frame: Frame; seconds: number }> {
    const start = now - ms;
    let first = this.frames.findIndex((f) => f.at > start);
    if (first === -1) first = this.frames.length;
    // The frame showing when the window opens.
    if (first > 0) first--;
    const picked = this.frames.slice(first).filter((f) => f.at <= now);
    return picked.map((frame, i) => {
      const from = Math.max(frame.at, start);
      const to = picked[i + 1]?.at ?? now;
      return { frame, seconds: Math.max(0, (to - from) / 1000) };
    });
  }
}

export const FLIGHT_FPS = 30;

/**
 * Which captured frame each output frame shows, at a constant `fps`: output
 * frame k (at its midpoint in time) shows the newest capture before it. The
 * stream is then exactly as long as the window. ffmpeg's concat demuxer with
 * per-image durations is not: it stretched 3.05 s of images to 5.03 s.
 */
export function frameSchedule(seconds: number[], fps = FLIGHT_FPS): number[] {
  const total = seconds.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let i = 0;
  let edge = seconds[0] ?? 0;
  for (let k = 0; k < Math.max(1, Math.round(total * fps)); k++) {
    const t = (k + 0.5) / fps;
    while (i < seconds.length - 1 && t >= edge) edge += seconds[++i];
    out.push(i);
  }
  return out;
}

/**
 * JPEGs on stdin at a constant rate to H.264 for the web. A capture whose
 * size differs (the viewport changed) is fitted into the last frame's size,
 * so the stream keeps one size throughout.
 */
export function ffmpegArgs(out: string, size: { width: number; height: number } | null, fps = FLIGHT_FPS): string[] {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const fit = size
    ? `scale=${even(size.width)}:${even(size.height)}:force_original_aspect_ratio=decrease,pad=${even(size.width)}:${even(size.height)}:(ow-iw)/2:(oh-ih)/2`
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-vf", fit, "-r", String(fps),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    out,
  ];
}

/** Seconds as a flag gives them, bounded; a refusal names the range. */
export function parseSeconds(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > max) throw new Error(`--seconds takes 1 to ${max}`);
  return Math.round(n);
}

// ── Where a session's recorder lives ────────────────────────────────────────

/** The socket and state file of `session`'s recorder. Hashed: a unix socket path has about 100 bytes. */
export function flightPaths(session: string, dir = codecastPath("browser", "flight")): { dir: string; sock: string; state: string; log: string } {
  const key = crypto.createHash("sha256").update(session).digest("hex").slice(0, 16);
  return { dir, sock: path.join(dir, `${key}.sock`), state: path.join(dir, `${key}.json`), log: path.join(dir, `${key}.log`) };
}

export interface FlightState {
  pid: number;
  session: string;
  targetId: string;
  url: string;
  seconds: number;
  startedAt: number;
}

// ── The recorder process ────────────────────────────────────────────────────

/** What `flight start` hands the recorder, on its stdin (the bridge socket URL carries a token, so never argv). */
export interface RecorderConfig {
  cdp: string;
  targetId: string;
  session: string;
  url: string;
  seconds: number;
  sock: string;
  state: string;
}

export type FlightRequest = { op: "status" } | { op: "save"; seconds: number; dir: string } | { op: "stop" };

/** The longest request line the socket reads; anything longer is refused. */
const MAX_REQUEST_BYTES = 16 * 1024;

/**
 * One request line from the local socket, checked: anything else on it
 * (garbage, an unknown op, a save without a usable window or directory) is a
 * refusal sent back, never a throw that takes the recorder down and never
 * read as a stop.
 */
export function parseFlightRequest(line: string): FlightRequest | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { error: "not JSON" };
  }
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { error: "not a request" };
  if (r.op === "status" || r.op === "stop") return { op: r.op };
  if (r.op === "save") {
    if (typeof r.seconds !== "number" || !Number.isFinite(r.seconds) || r.seconds <= 0) return { error: "save needs seconds > 0" };
    if (typeof r.dir !== "string" || !r.dir || !path.isAbsolute(r.dir)) return { error: "save needs an absolute dir" };
    return { op: "save", seconds: r.seconds, dir: r.dir };
  }
  return { error: `unknown op ${JSON.stringify(r.op)}` };
}

export interface FlightSaved {
  file: string;
  poster: string;
  seconds: number;
  frames: number;
  bytes: number;
}

export interface FlightStatus {
  url: string;
  seconds: number;
  covered: number;
  frames: number;
  bytes: number;
  received: number;
  dropped: number;
  startedAt: number;
}

/** Encode the window into `dir`/flight.mp4 and `dir`/poster.jpg. */
export async function encodeWindow(
  ring: FrameRing,
  seconds: number,
  dir: string,
  now = Date.now(),
  run: (args: string[], frames: Buffer[]) => Promise<{ code: number; stderr: string }> = runFfmpeg,
): Promise<FlightSaved> {
  const picked = ring.window(seconds * 1000, now);
  if (!picked.length) throw new Error("no frames yet: the tab has not painted since the recorder started");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const last = picked.at(-1)!.frame.data;
  const frames = frameSchedule(picked.map((p) => p.seconds)).map((i) => picked[i].frame.data);
  const file = path.join(dir, "flight.mp4");
  const res = await run(ffmpegArgs(file, imageSize(last)), frames);
  if (res.code !== 0) throw new Error(`ffmpeg failed: ${res.stderr.trim().split("\n").slice(-3).join(" ")}`);
  const poster = path.join(dir, "poster.jpg");
  fs.writeFileSync(poster, last, { mode: 0o600 });
  return { file, poster, seconds: frames.length / FLIGHT_FPS, frames: picked.length, bytes: fs.statSync(file).size };
}

/** ffmpeg with `frames` written to its stdin in order, minding backpressure. */
function runFfmpeg(args: string[], frames: Buffer[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 127, stderr: (err as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg is not installed (brew install ffmpeg)" : err.message }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
    const stdin = child.stdin!;
    stdin.on("error", () => {});
    let i = 0;
    const pump = () => {
      while (i < frames.length) if (!stdin.write(frames[i++])) return void stdin.once("drain", pump);
      stdin.end();
    };
    pump();
  });
}

/**
 * The recorder: attach, screencast into the ring, answer requests on the
 * socket, and end on `stop`, when the tab or the connection goes, or at
 * FLIGHT_MAX_LIFETIME_MS.
 */
export async function runRecorder(cfg: RecorderConfig, connect: (url: string) => Promise<CdpClient> = (u) => CdpConnection.connect(u, 8000)): Promise<void> {
  const ring = new FrameRing(cfg.seconds * 1000);
  const conn = await connect(cfg.cdp);
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: cfg.targetId, flatten: true });
  let lastScreencastAt = 0;
  let ended = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => (finish = r));
  const end = () => {
    if (ended) return;
    ended = true;
    finish();
  };

  conn.on((ev) => {
    if (ev.method === "Page.screencastFrame" && ev.sessionId === sessionId) {
      const p = ev.params as { data: string; sessionId: number };
      lastScreencastAt = Date.now();
      ring.push({ data: Buffer.from(p.data, "base64"), at: lastScreencastAt });
      conn.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sessionId).catch(() => {});
    } else if ((ev.method === "Target.detachedFromTarget" && (ev.params as any)?.sessionId === sessionId) || ev.method === "Inspector.detached") {
      end();
    }
  });
  await conn.send("Page.enable", {}, sessionId).catch(() => {});
  await conn.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }, sessionId);

  // A tab Chrome is not painting sends no screencast frames: screenshots fill in, a repeat dropped.
  let shooting = false;
  const poll = setInterval(async () => {
    if (shooting || ended || Date.now() - lastScreencastAt < SCREENCAST_QUIET_MS) return;
    shooting = true;
    try {
      const { data } = await conn.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 }, sessionId, 5_000);
      const buf = Buffer.from(data, "base64");
      const last = ring.last;
      if (!last || !last.data.equals(buf)) ring.push({ data: buf, at: Date.now() });
    } catch (err) {
      if (/No target|not attached|detached|closed/i.test((err as Error).message)) end();
    } finally {
      shooting = false;
    }
  }, SCREENSHOT_EVERY_MS);
  const lifetime = setTimeout(end, FLIGHT_MAX_LIFETIME_MS);

  const state: FlightState = { pid: process.pid, session: cfg.session, targetId: cfg.targetId, url: cfg.url, seconds: cfg.seconds, startedAt: Date.now() };
  fs.mkdirSync(path.dirname(cfg.sock), { recursive: true, mode: 0o700 });
  fs.rmSync(cfg.sock, { force: true });
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", async (d) => {
      const reply = (body: unknown) => sock.end(JSON.stringify(body) + "\n");
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        if (buf.length > MAX_REQUEST_BYTES) {
          buf = "";
          reply({ ok: false, error: "request too long" });
        }
        return;
      }
      const req = parseFlightRequest(buf.slice(0, nl));
      buf = "";
      if ("error" in req) return reply({ ok: false, error: req.error });
      try {
        if (req.op === "status") {
          reply({ ok: true, status: { url: cfg.url, seconds: cfg.seconds, covered: ring.coveredMs(Date.now()) / 1000, frames: ring.frames.length, bytes: ring.bytes, received: ring.received, dropped: ring.dropped, startedAt: state.startedAt } satisfies FlightStatus });
        } else if (req.op === "save") {
          reply({ ok: true, saved: await encodeWindow(ring, Math.min(req.seconds, cfg.seconds), req.dir) });
        } else {
          reply({ ok: true });
          end();
        }
      } catch (err) {
        reply({ ok: false, error: (err as Error).message });
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(cfg.sock, () => resolve()));
  fs.chmodSync(cfg.sock, 0o600);
  fs.writeFileSync(cfg.state, JSON.stringify(state), { mode: 0o600 });

  await done;
  clearInterval(poll);
  clearTimeout(lifetime);
  await conn.send("Page.stopScreencast", {}, sessionId).catch(() => {});
  await conn.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  conn.close();
  // Let the stop reply flush before the socket goes.
  await new Promise((r) => setTimeout(r, 100));
  server.close();
  fs.rmSync(cfg.sock, { force: true });
  fs.rmSync(cfg.state, { force: true });
}

// ── Talking to it ───────────────────────────────────────────────────────────

/** One request to the session's recorder; null when none is running there. */
export function askRecorder(sock: string, req: FlightRequest, timeoutMs = 120_000): Promise<any | null> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(sock)) return resolve(null);
    const c = net.connect(sock);
    let buf = "";
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error("the flight recorder did not answer"));
    }, timeoutMs);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", (d) => (buf += d));
    c.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("the flight recorder sent a reply that is not JSON"));
      }
    });
    c.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // A socket left by a recorder that died: there is no recorder.
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        fs.rmSync(sock, { force: true });
        resolve(null);
      } else reject(err);
    });
  });
}

/** Launch a recorder for `cfg`, detached, and wait until its socket answers. */
export async function launchRecorder(cfg: RecorderConfig, log: string, timeoutMs = 15_000): Promise<FlightStatus> {
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const out = fs.openSync(log, "a", 0o600);
  const { cmd, prefixArgs } = resolveCastInvocation();
  const child = spawn(cmd, [...prefixArgs, "browser", "flight", "run"], { detached: true, stdio: ["pipe", out, out], env: process.env });
  child.stdin!.end(JSON.stringify(cfg));
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + timeoutMs;
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 1));
  while (Date.now() < deadline) {
    if (exited !== null) break;
    const res = await askRecorder(cfg.sock, { op: "status" }, 3_000).catch(() => null);
    if (res?.ok) return res.status as FlightStatus;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tail = fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").slice(-3).join(" ") : "";
  throw new Error(`the flight recorder did not start${tail ? `: ${tail}` : ""}`);
}

/** A saved video as a page: the cast player shows a bundle's <video controls>. */
export function flightPageHtml(title: string): string {
  const esc = title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc}</title>` +
    `<style>body{margin:0;background:#111}video{display:block;width:100%;height:auto}</style></head>` +
    `<body><video controls playsinline poster="poster.jpg" src="flight.mp4"></video></body></html>\n`;
}

// ── The verbs ───────────────────────────────────────────────────────────────

/** `cast browser flight start|save|stop|status`. One recorder per agent session, whichever tab it started on. */
export function registerFlightCommand(br: Command, deps: PublishDeps): void {
  const paths = () => flightPaths(ownerKey(deps.detectCurrentSessionId) ?? "default");
  const ok = (s: string) => console.log(`${fmt.success(icons.check)} ${s}`);
  const describe = (s: FlightStatus) => `${Math.round(s.covered)}s of ${s.seconds}s buffered, ${s.frames} frames, ${formatBytes(s.bytes)}`;

  const flight = br
    .command("flight")
    .description("Keep a rolling video of this session's tab in memory; save the last seconds as an mp4 when something goes wrong")
    .addHelpText(
      "after",
      `
  cast browser flight start               # buffer the last 60s (--seconds up to ${FLIGHT_MAX_SECONDS})
  cast browser flight save                # the last ${FLIGHT_SAVE_DEFAULT_SECONDS}s as an mp4, posted as a page; --local keeps it here
  cast browser flight stop

The buffer is memory only (at most ${formatBytes(FLIGHT_MAX_BYTES)}) and nothing is written until a save.
It records what the tab shows: a field showing a secret in plain text shows in the video.`,
    );

  targetFlags(flight.command("start"))
    .description("Start buffering this session's tab")
    .option("--seconds <n>", `How much to keep, 1 to ${FLIGHT_MAX_SECONDS}`, String(FLIGHT_DEFAULT_SECONDS))
    .action(async (o: TargetChoice & { seconds: string }) => {
      let seconds: number;
      try {
        seconds = parseSeconds(o.seconds, FLIGHT_DEFAULT_SECONDS, FLIGHT_MAX_SECONDS);
      } catch (err) {
        fail((err as Error).message);
      }
      const p = paths();
      const running = await askRecorder(p.sock, { op: "status" }, 5_000).catch(() => null);
      if (running?.ok) return ok(`already recording ${running.status.url}: ${describe(running.status)}`);
      let tab: SessionTab;
      try {
        tab = await openSessionTab(o, deps);
      } catch (err) {
        fail(`${(err as Error).message}${(err as { hint?: string }).hint ? `\n  ${(err as { hint?: string }).hint}` : ""}`);
      }
      tab.conn.close();
      try {
        const status = await launchRecorder({ cdp: tab.browserUrl, targetId: tab.targetId, session: tab.session, url: tab.url, seconds, sock: p.sock, state: p.state }, p.log);
        ok(`recording ${status.url || "the tab"}, keeping the last ${seconds}s`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  flight
    .command("save")
    .description("Write the last seconds as an mp4 and post it")
    .option("--seconds <n>", `How much, 1 to ${FLIGHT_MAX_SECONDS}`, String(FLIGHT_SAVE_DEFAULT_SECONDS))
    .option("--local", "Keep the video on this machine; do not publish it")
    .option("--title <text>", "The page's title: say what it shows")
    .option("--json", "Print {file, poster, seconds, frames, bytes, url}")
    .action(async (o: { seconds: string; local?: boolean; title?: string; json?: boolean }) => {
      let seconds: number;
      try {
        seconds = parseSeconds(o.seconds, FLIGHT_SAVE_DEFAULT_SECONDS, FLIGHT_MAX_SECONDS);
      } catch (err) {
        fail((err as Error).message);
      }
      const dir = agentTempPath("flight", `flight-${Date.now()}`);
      const res = await askRecorder(paths().sock, { op: "save", seconds, dir }).catch((err) => fail((err as Error).message));
      if (!res) fail("no flight recorder is running for this session: cast browser flight start");
      if (!res.ok) fail(res.error);
      const saved = res.saved as FlightSaved;
      let url: string | undefined;
      if (!o.local) {
        const title = o.title || `Browser flight recording, ${new Date().toLocaleString()}`;
        fs.writeFileSync(path.join(dir, "index.html"), flightPageHtml(title));
        try {
          const { result } = await publishOnce(deps, dir, { title }, { sessionRef: deps.detectCurrentSessionId() ?? undefined, withThumb: false, forceNew: true, exitOnError: false });
          url = result?.url;
        } catch (err) {
          console.error(fmt.warning(`! not published (${(err as Error).message}); the video is at ${saved.file}`));
        }
      }
      if (o.json) return console.log(JSON.stringify({ ...saved, ...(url ? { url } : {}) }));
      ok(`saved ${saved.seconds.toFixed(1)}s (${saved.frames} frames, ${formatBytes(saved.bytes)}) to ${saved.file}`);
      console.log(inlineImageMarker(saved.poster));
      if (url) console.log(`${url}\n  ${fmt.muted("Put the URL alone on a line in your reply: it plays inline in the conversation")}`);
    });

  flight
    .command("status")
    .description("Is a recorder running, and how much it holds")
    .action(async () => {
      const res = await askRecorder(paths().sock, { op: "status" }, 5_000).catch((err) => fail((err as Error).message));
      if (!res?.ok) return console.log("no flight recorder is running for this session");
      ok(`recording ${res.status.url}: ${describe(res.status)}${res.status.dropped ? `, ${res.status.dropped} frames dropped at the byte cap` : ""}`);
    });

  flight
    .command("stop")
    .description("Stop recording and drop the buffer")
    .action(async () => {
      const res = await askRecorder(paths().sock, { op: "stop" }, 10_000).catch((err) => fail((err as Error).message));
      if (!res) return console.log("no flight recorder was running for this session");
      ok("stopped; the buffer is gone");
    });

  flight
    .command("run", { hidden: true })
    .description("The recorder process itself (flight start launches it; its config arrives on stdin)")
    .action(async () => {
      const cfg = JSON.parse(fs.readFileSync(0, "utf-8")) as RecorderConfig;
      try {
        await runRecorder(cfg);
        process.exit(0);
      } catch (err) {
        console.error(`flight recorder: ${(err as Error).message}`);
        fs.rmSync(cfg.sock, { force: true });
        fs.rmSync(cfg.state, { force: true });
        process.exit(1);
      }
    });
}
