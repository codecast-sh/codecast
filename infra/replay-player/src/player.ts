// The replay player page's script (docs/architecture/external-data.md X5,
// "Playing a replay"; contracts/replayPlayer.ts). Runs on replay.codecast.sh,
// never on codecast.sh: the page it draws is a customer's DOM.
//
// It trades the capability in its path for the manifest (Convex), reads the
// DOM chunks (signed R2 URLs), and hands them to rrweb's Replayer, which
// rebuilds the page inside an iframe sandboxed without allow-scripts, so
// nothing the recording holds ever runs. The page's own CSP (script-src
// 'self') says the same a second time.
//
// Two modes:
//   interactive  people: a control bar (unless controls=0), and postMessage
//                both ways with the page embedding it (time, play, pause, speed)
//   frame        the frame renderer: draw the page as it was at t, wait for
//                its images and fonts, then say so (window.__codecastReplay,
//                and a "frame" message); __codecastReplaySeek(t) draws another
//
// Every time it speaks is on the replay clock (ms since the stream's first
// event), mapped from rrweb's own offsets through the manifest's t0.
import { Replayer } from "@rrweb/replay";
import {
  REPLAY_FRAME_LIMITS,
  REPLAY_PLAYER_SOURCE,
  REPLAY_PLAYER_SPEEDS,
  parseReplayHostMessage,
  parseReplayPlayerUrl,
  type ReplayPlayerManifest,
  type ReplayPlayerMessage,
} from "../../../packages/shared/contracts/replayPlayer";

type FrameState =
  | { state: "loading" }
  | { state: "ready"; t_ms: number; url: string | null; width: number; height: number; outline: string }
  | { state: "error"; message: string };

declare global {
  interface Window {
    __codecastReplay: FrameState;
    __codecastReplaySeek?: (t: number) => Promise<FrameState>;
  }
}

const CONTROLS_H = 44;

/** A player message without its tag, one variant at a time. */
type Outgoing = ReplayPlayerMessage extends infer M ? (M extends ReplayPlayerMessage ? Omit<M, "source"> : never) : never;

function post(msg: Outgoing) {
  if (window.parent !== window) window.parent.postMessage({ source: REPLAY_PLAYER_SOURCE, ...msg }, "*");
}

function fail(message: string) {
  window.__codecastReplay = { state: "error", message };
  const box = document.getElementById("status");
  if (box) {
    box.textContent = message;
    box.hidden = false;
  }
  post({ type: "error", message });
}

async function readChunk(url: string): Promise<unknown[]> {
  const res = await fetch(url, { referrerPolicy: "no-referrer", credentials: "omit" });
  if (!res.ok) throw new Error(`a recording chunk answered ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  // R2 serves a chunk stored with Content-Encoding: gzip already inflated; a
  // chunk uploaded without that header arrives as the gzip bytes themselves.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(inflated).arrayBuffer());
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return Array.isArray(parsed) ? parsed : [];
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** The page's address at an rrweb offset: the newest Meta event at or before it. */
function urlAt(events: any[], startTime: number, offset: number): string | null {
  let href: string | null = null;
  for (const e of events) {
    if (e.timestamp - startTime > offset) break;
    if (e.type === 4 && typeof e.data?.href === "string") href = e.data.href;
  }
  return href;
}

/** Wait until the replayed document's images and fonts have loaded, or the settle bound passes. */
async function settle(doc: Document | null | undefined): Promise<void> {
  const deadline = Date.now() + REPLAY_FRAME_LIMITS.settle_ms;
  const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  await frames();
  if (!doc) return;
  const fonts = (doc as any).fonts?.ready?.catch(() => {});
  while (Date.now() < deadline) {
    const pending = Array.from(doc.images ?? []).some((img) => !img.complete);
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await Promise.race([fonts, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
  await frames();
}

async function main() {
  window.__codecastReplay = { state: "loading" };
  const params = parseReplayPlayerUrl(location.href);
  if (!params) return fail("This is not a replay link.");
  const manifestOrigin = document.body.dataset.manifestOrigin!;
  const manifestPath = document.body.dataset.manifestPath!;
  const mode = params.mode ?? "interactive";
  const showControls = mode === "interactive" && params.controls !== false;

  let manifest: ReplayPlayerManifest;
  try {
    const res = await fetch(`${manifestOrigin}${manifestPath}?cap=${encodeURIComponent(params.cap)}`, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) return fail(res.status === 404 ? "This replay link has expired. Open the replay again for a fresh one." : `The replay could not be opened (${res.status}).`);
    manifest = await res.json();
  } catch (err) {
    return fail(`The replay could not be opened: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!manifest.dom_urls.length) return fail("This replay keeps no page capture to play.");

  let events: any[] = [];
  try {
    for (const url of manifest.dom_urls) events = events.concat(await readChunk(url));
  } catch (err) {
    return fail(`The recording could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  events = events.filter((e) => e && typeof e.type === "number" && typeof e.timestamp === "number").sort((a, b) => a.timestamp - b.timestamp);
  if (!events.some((e) => e.type === 2)) return fail("This capture has no full snapshot of the page, so there is nothing to draw.");

  const stage = document.getElementById("stage")!;
  const replayer = new Replayer(events, {
    root: stage,
    skipInactive: false,
    showWarning: false,
    showDebug: false,
    mouseTail: false,
    triggerFocus: false,
    UNSAFE_replayCanvas: false,
    pauseAnimation: true,
    speed: 1,
  });
  const meta = replayer.getMetaData();
  const lead = meta.startTime - manifest.t0;
  const toOffset = (t: number) => Math.min(Math.max(0, t - lead), meta.totalTime);
  const toClock = (offset: number) => Math.max(0, offset + lead);
  // rrweb draws the events strictly before the offset it is given; a moment
  // includes what happened at it, so it is drawn a millisecond past.
  const drawAt = (offset: number) => offset + 1;
  const duration = toClock(meta.totalTime);

  let size = { width: 1024, height: 768 };
  const firstMeta = events.find((e) => e.type === 4 && e.data?.width && e.data?.height);
  if (firstMeta) size = { width: firstMeta.data.width, height: firstMeta.data.height };

  const layout = () => {
    const availW = mode === "frame" ? REPLAY_FRAME_LIMITS.max_width : window.innerWidth;
    const availH = mode === "frame" ? REPLAY_FRAME_LIMITS.max_height : window.innerHeight - (showControls ? CONTROLS_H : 0);
    const scale = Math.min(1, availW / size.width, availH / size.height);
    const w = Math.round(size.width * scale), h = Math.round(size.height * scale);
    stage.style.width = `${w}px`;
    stage.style.height = `${h}px`;
    if (mode === "interactive") {
      stage.style.left = `${Math.max(0, Math.round((window.innerWidth - w) / 2))}px`;
      stage.style.top = `${Math.max(0, Math.round((availH - h) / 2))}px`;
    }
    replayer.wrapper.style.transform = `scale(${scale})`;
    replayer.wrapper.style.transformOrigin = "0 0";
    document.body.dataset.frameWidth = String(w);
    document.body.dataset.frameHeight = String(h);
  };
  replayer.on("resize", (d: any) => {
    if (d?.width && d?.height) size = { width: d.width, height: d.height };
    layout();
  });
  window.addEventListener("resize", layout);
  layout();

  if (mode === "frame") {
    const draw = async (t: number): Promise<FrameState> => {
      const offset = toOffset(t);
      replayer.pause(drawAt(offset));
      layout();
      await settle(replayer.iframe.contentDocument);
      const text = (replayer.iframe.contentDocument?.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
      const state: FrameState = {
        state: "ready",
        t_ms: toClock(offset),
        url: urlAt(events, meta.startTime, offset),
        width: Number(document.body.dataset.frameWidth),
        height: Number(document.body.dataset.frameHeight),
        outline: text.slice(0, REPLAY_FRAME_LIMITS.outline_max_chars),
      };
      window.__codecastReplay = state;
      post({ type: "frame", t_ms: state.t_ms, url: state.url, width: state.width, height: state.height });
      return state;
    };
    window.__codecastReplaySeek = draw;
    await draw(params.t_ms ?? 0);
    return;
  }

  // ── Interactive ──
  let playing = false;
  let speed = 1;
  const bar = document.getElementById("controls")!;
  const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
  const scrub = document.querySelector<HTMLInputElement>("#scrub")!;
  const clock = document.getElementById("clock")!;
  const speedSel = document.querySelector<HTMLSelectElement>("#speed")!;
  bar.hidden = !showControls;
  scrub.max = String(duration);
  for (const s of REPLAY_PLAYER_SPEEDS) speedSel.add(new Option(`${s}x`, String(s), s === 1, s === 1));

  const now = () => toClock(replayer.getCurrentTime());
  const paint = () => {
    const t = now();
    scrub.value = String(t);
    clock.textContent = `${fmt(t)} / ${fmt(duration)}`;
    toggle.textContent = playing ? "Pause" : "Play";
  };
  const sendTime = () => post({ type: "time", t_ms: now(), playing });
  const setPlaying = (on: boolean, at?: number) => {
    const offset = at === undefined ? replayer.getCurrentTime() : toOffset(at);
    if (on) replayer.play(offset >= meta.totalTime ? 0 : offset);
    else replayer.pause(at === undefined ? offset : drawAt(offset));
    playing = on;
    paint();
    post({ type: "state", playing, speed });
    sendTime();
  };
  const seek = (t: number, play = playing) => setPlaying(play, t);

  replayer.on("finish", () => {
    playing = false;
    paint();
    post({ type: "state", playing, speed });
    sendTime();
  });
  toggle.addEventListener("click", () => setPlaying(!playing));
  scrub.addEventListener("input", () => seek(Number(scrub.value), false));
  speedSel.addEventListener("change", () => {
    speed = Number(speedSel.value);
    replayer.setConfig({ speed });
    post({ type: "state", playing, speed });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && e.target === document.body) {
      e.preventDefault();
      setPlaying(!playing);
    }
  });
  window.addEventListener("message", (e) => {
    const msg = parseReplayHostMessage(e.data);
    if (!msg) return;
    if (msg.type === "seek") seek(msg.t_ms, msg.play ?? playing);
    else if (msg.type === "play") setPlaying(true);
    else if (msg.type === "pause") setPlaying(false);
    else if (msg.type === "speed") {
      speed = msg.speed;
      speedSel.value = String(speed);
      replayer.setConfig({ speed });
      post({ type: "state", playing, speed });
    }
  });
  setInterval(() => {
    if (!playing) return;
    paint();
    sendTime();
  }, 250);

  const start = params.t_ms ?? 0;
  replayer.pause(drawAt(toOffset(start)));
  paint();
  window.__codecastReplay = { state: "ready", t_ms: now(), url: urlAt(events, meta.startTime, toOffset(start)), width: size.width, height: size.height, outline: "" };
  post({ type: "ready", duration_ms: duration, width: size.width, height: size.height, t_ms: now() });
  if (params.autoplay) setPlaying(true);
}

main().catch((err) => fail(`The player stopped: ${err instanceof Error ? err.message : String(err)}`));
