// replay.codecast.sh: the replay player and the frame renderer
// (docs/architecture/external-data.md X5, "Playing a replay";
// packages/shared/contracts/replayPlayer.ts).
//
//   GET  /p/<cap>[?t=&mode=frame&controls=0&autoplay=1]   the player page
//   GET  /player.js, /player.css                           its static assets (public/, built by `bun run build`)
//   POST /frame { cap, times_ms }                          frames as PNG, rendered in Cloudflare's browser
//
// Its own origin on purpose: the player draws a customer's DOM, and that
// markup must never share an origin with codecast.sh (nor with a.codecast.sh,
// where anyone's published HTML runs). The page holds no session. It trades
// the capability in its path for signed chunk URLs at Convex, which checks
// the capability and the person it was minted for; this worker never
// verifies a capability itself, and holds no secret.
//
// A frame is the same page in frame mode, loaded by Cloudflare Browser
// Rendering (the `BROWSER` binding, Workers Paid): it draws the page at a
// time, waits for the replayed images and fonts, and screenshots the stage.
// A request is admitted by Convex before a browser starts (POST
// REPLAY_FRAME_ADMIT_PATH): the capability opens, and it and the person it
// names still have frame budget (REPLAY_FRAME_LIMITS.requests_per_cap,
// requests_per_person), so a forged capability costs one POST and a valid
// one buys a bounded number of browser sessions.
//
// What the replayed page may fetch. A recording names its own images,
// stylesheets and fonts, and anyone holding a source's public ingest key can
// upload a recording that names any URL, so a replay readable in a workspace
// is no promise about the hosts it names. By default the page loads nothing
// remote in either mode: its CSP allows no remote host for styles, images,
// fonts or media, so remote images show as empty boxes (stylesheets are
// inlined by the recorder and still apply). In interactive mode the viewer
// may opt in on one view (`assets=remote`, which the player offers as a
// button naming the hosts): only then does the viewer's browser fetch them
// over https, and those hosts learn the viewer's IP and user agent (never a
// referrer). Frame mode never opts in, and the renderer also intercepts every
// request its browser makes and lets through only this worker, Convex, the
// replays bucket (REPLAYS_BUCKET_URL) and data:/blob:, so Cloudflare's
// browser never fetches a URL a recording chose.
import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import {
  REPLAY_FRAME_ADMIT_PATH,
  REPLAY_FRAME_LIMITS,
  REPLAY_FRAME_PATH,
  REPLAY_MANIFEST_ORIGIN,
  REPLAY_PLAYER_MANIFEST_PATH,
  REPLAY_PLAYER_ORIGIN,
  parseReplayPlayerUrl,
  replayPlayerUrl,
  type ReplayFrame,
  type ReplayFrameRequest,
} from "../../../packages/shared/contracts/replayPlayer";

export interface Env {
  /** Browser Rendering. */
  BROWSER: BrowserWorker;
  /** Static assets (player.js, player.css). */
  ASSETS?: Fetcher;
  /** Where the page reads its manifest. Defaults to convex.codecast.sh. */
  CONVEX_ORIGIN?: string;
  /** This worker's own public origin, which the renderer loads the page from. Defaults to replay.codecast.sh. */
  PLAYER_ORIGIN?: string;
  /**
   * The replays bucket, path style: `https://<account>.r2.cloudflarestorage.com/<bucket>/`,
   * the prefix every signed DOM chunk URL Convex hands out starts with. The
   * page and the renderer read chunks from here and nowhere else in R2;
   * unset, they read from no bucket at all.
   */
  REPLAYS_BUCKET_URL?: string;
}

/** The replays bucket as an origin and a path prefix, or null when unset or malformed. */
export function replaysBucket(url: string | undefined): { origin: string; prefix: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const prefix = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
    if (u.protocol !== "https:" || prefix === "/") return null;
    return { origin: u.origin, prefix };
  } catch {
    return null;
  }
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

/**
 * The CSP the player page runs under. Scripts are this origin's alone, and
 * the page reads only Convex and the replays bucket. The replayed page's own
 * remote styles, images, fonts and media load only when the viewer opted in
 * on this view (`remoteAssets`, interactive mode); otherwise nothing remote
 * loads (see the header).
 */
export function playerCsp(convexOrigin: string, bucketUrl: string | undefined, opts: { mode?: "interactive" | "frame"; remoteAssets?: boolean } = {}): string {
  const remote = opts.mode !== "frame" && opts.remoteAssets ? " https:" : "";
  const bucket = replaysBucket(bucketUrl);
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline'${remote} data: blob:`,
    `img-src${remote} data: blob:`,
    `font-src${remote} data:`,
    `media-src${remote} data: blob:`,
    `connect-src ${convexOrigin}${bucket ? ` ${bucket.origin}${bucket.prefix}` : ""}`,
    "frame-src 'self' about:",
    "base-uri 'none'",
    "form-action 'none'",
    // A capability is the whole authorization, so whoever holds one may embed it.
    "frame-ancestors *",
  ].join("; ");
}

/** The player page. Everything it does is player.js; the body names where the manifest is. */
export function playerPage(convexOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Replay</title>
<link rel="stylesheet" href="/player.css">
<style>
  html, body { margin: 0; height: 100%; background: #fff; overflow: hidden; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  #stage { position: absolute; left: 0; top: 0; overflow: hidden; background: #fff; }
  #stage .replayer-wrapper { position: relative; }
  #stage iframe { border: 0; background: #fff; }
  #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: #555; background: #fafafa; }
  #controls { position: absolute; left: 0; right: 0; bottom: 0; height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 12px; box-sizing: border-box; background: #111; color: #eee; }
  #controls button, #controls select, #strip button { font: inherit; background: #222; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
  #scrub { flex: 1; accent-color: #6aa3ff; }
  #strip { position: absolute; left: 0; right: 0; bottom: 0; height: 28px; display: flex; align-items: center; padding: 0 6px; box-sizing: border-box; background: #111; }
  #controls #remote, #strip #remote { min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #9aa4ad; background: transparent; border: 1px solid transparent; }
  #strip #remote { max-width: 100%; padding: 2px 8px; }
  #controls #remote:hover, #strip #remote:hover, #remote:focus-visible { color: #eee; border-color: #333; background: #1b1b1b; }
  #clock { font-variant-numeric: tabular-nums; min-width: 96px; text-align: right; }
  [hidden] { display: none !important; }
</style>
</head>
<body data-manifest-origin="${convexOrigin}" data-manifest-path="${REPLAY_PLAYER_MANIFEST_PATH}">
<div id="stage"></div>
<div id="status" hidden></div>
<div id="strip" hidden></div>
<div id="controls" hidden>
  <button id="toggle" type="button">Play</button>
  <input id="scrub" type="range" min="0" max="0" step="100" value="0" aria-label="Position">
  <span id="clock">0:00 / 0:00</span>
  <select id="speed" aria-label="Speed"></select>
  <button id="remote" type="button" hidden></button>
</div>
<script src="/player.js"></script>
</body>
</html>`;
}

/** The frame request, checked, or why it is refused. */
export function validateFrameRequest(body: unknown): ReplayFrameRequest | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.cap !== "string" || !b.cap || b.cap.length > 1024) return "cap must be the capability replays.playerLink minted";
  if (!Array.isArray(b.times_ms) || !b.times_ms.length) return "times_ms must list at least one time";
  if (b.times_ms.length > REPLAY_FRAME_LIMITS.max_frames_per_request) return `at most ${REPLAY_FRAME_LIMITS.max_frames_per_request} frames per request`;
  if (!b.times_ms.every((t) => typeof t === "number" && Number.isFinite(t) && t >= 0)) return "every time must be a number of ms, 0 or more";
  return { cap: b.cap, times_ms: [...(b.times_ms as number[])].sort((x, y) => x - y) };
}

/**
 * Whether Convex admits a frame request on this capability: 204 opens it, and
 * a refusal is relayed as the response to send (404 dead, 429 past budget).
 */
async function admitFrames(convexOrigin: string, cap: string, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
  const res = await fetchImpl(`${convexOrigin}${REPLAY_FRAME_ADMIT_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cap }) });
  await res.body?.cancel().catch(() => {});
  if (res.ok) return null;
  if (res.status === 429) {
    return json(429, { error: "This replay link has used its frames for now; try again in a few minutes." }, { "Retry-After": res.headers.get("Retry-After") ?? "60" });
  }
  if (res.status === 404) return json(404, { error: "This replay link has expired or does not exist. Ask for a fresh one." });
  return json(503, { error: `The frame request could not be checked (${res.status}); try again.` }, { "Retry-After": "5" });
}

/** Whether the frame renderer's browser may fetch this URL: the player, Convex, the replays bucket, and inline data. */
export function frameRequestAllowed(url: string, origins: { player: string; convex: string; bucket?: string }): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank" || url === "about:srcdoc") return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin === new URL(origins.player).origin || u.origin === new URL(origins.convex).origin) return true;
  const bucket = replaysBucket(origins.bucket);
  return !!bucket && u.origin === bucket.origin && u.pathname.startsWith(bucket.prefix);
}

type PageState = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; t_ms: number; url: string | null; width: number; height: number; outline: string };

async function renderFrames(env: Env, req: ReplayFrameRequest): Promise<ReplayFrame[]> {
  const origin = env.PLAYER_ORIGIN || REPLAY_PLAYER_ORIGIN;
  const origins = { player: origin, convex: env.CONVEX_ORIGIN || REPLAY_MANIFEST_ORIGIN, bucket: env.REPLAYS_BUCKET_URL };
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.isInterceptResolutionHandled()) return;
      if (frameRequestAllowed(r.url(), origins)) r.continue().catch(() => {});
      else r.abort("blockedbyclient").catch(() => {});
    });
    await page.setViewport({ width: REPLAY_FRAME_LIMITS.max_width, height: REPLAY_FRAME_LIMITS.max_height, deviceScaleFactor: 1 });
    await page.goto(replayPlayerUrl({ cap: req.cap, t_ms: req.times_ms[0], mode: "frame" }, origin), { waitUntil: "load", timeout: 30_000 });
    await page.waitForFunction("window.__codecastReplay && window.__codecastReplay.state !== 'loading'", { timeout: 60_000 });
    const first = (await page.evaluate("window.__codecastReplay")) as PageState;
    if (first.state === "error") throw new FrameError(first.message, 422);
    const frames: ReplayFrame[] = [];
    for (let i = 0; i < req.times_ms.length; i++) {
      const t = req.times_ms[i];
      try {
        const s = (i === 0 ? first : await page.evaluate(`window.__codecastReplaySeek(${JSON.stringify(t)})`)) as PageState;
        if (s.state !== "ready") throw new Error(s.state === "error" ? s.message : "the page did not draw");
        const png = (await page.screenshot({ type: "png", encoding: "base64", clip: { x: 0, y: 0, width: Math.max(1, s.width), height: Math.max(1, s.height) } })) as string;
        frames.push({ t_ms: s.t_ms, png_base64: png, url: s.url, outline: s.outline, width: s.width, height: s.height });
      } catch (err) {
        frames.push({ t_ms: t, url: null, outline: "", width: 0, height: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return frames;
  } finally {
    await browser.close().catch(() => {});
  }
}

class FrameError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function handleFrame(request: Request, env: Env, deps: { fetch?: typeof fetch; render?: typeof renderFrames } = {}): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "body is not JSON" });
  }
  const req = validateFrameRequest(body);
  if (typeof req === "string") return json(400, { error: req });
  const refused = await admitFrames(env.CONVEX_ORIGIN || REPLAY_MANIFEST_ORIGIN, req.cap, deps.fetch);
  if (refused) return refused;
  try {
    return json(200, { frames: await (deps.render ?? renderFrames)(env, req) });
  } catch (err) {
    if (err instanceof FrameError) return json(err.status, { error: err.message });
    const message = err instanceof Error ? err.message : String(err);
    // The binding refuses a new session past the account's concurrent browser limit.
    if (/rate limit|429|too many/i.test(message)) return json(429, { error: "Every browser is busy; try again in a minute." }, { "Retry-After": "60" });
    return json(502, { error: `The frame could not be rendered: ${message}` });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const convexOrigin = env.CONVEX_ORIGIN || REPLAY_MANIFEST_ORIGIN;
    if (url.pathname === REPLAY_FRAME_PATH) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
      if (request.method !== "POST") return json(405, { error: "POST a frame request" });
      return handleFrame(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (/^\/p\/[^/]+\/?$/.test(url.pathname)) {
      const params = parseReplayPlayerUrl(request.url);
      return new Response(playerPage(convexOrigin), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": playerCsp(convexOrigin, env.REPLAYS_BUCKET_URL, { mode: params?.mode, remoteAssets: params?.remote_assets }),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      });
    }
    if (env.ASSETS && (url.pathname === "/player.js" || url.pathname === "/player.css")) return env.ASSETS.fetch(request);
    if (url.pathname === "/health") return new Response("ok");
    return new Response("Not found", { status: 404 });
  },
};
