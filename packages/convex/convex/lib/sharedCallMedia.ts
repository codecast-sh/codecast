// The HTTP routes that serve a publicly shared call's audio and video. Each
// request re-checks the link through internal.publicShare queries, so this
// file needs nothing from publicShare.ts itself, which reaches the big import
// cycle; http.ts mounts these without loading it (ct-92432).
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { callRecordingGetUrl } from "./r2";

/** Where a shared call's audio is served: under /cli/, the prefix the proxy
 *  in front of prod forwards to HTTP actions (see SHARED_CALL_VIDEO_PATH). */
export const SHARED_CALL_AUDIO_PATH = "/cli/share/call/audio";

/** Largest byte span one audio response carries: an HTTP action's response
 *  stops at about 20 MB. A player reads a longer file as several ranges. */
export const SHARED_AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;

/** The Range header to ask storage for: the player's own range, its end
 *  clamped so one response stays under the action's size limit. A request
 *  with no range (or one we cannot read) starts at byte 0. */
export function clampAudioRange(header: string | null, chunk = SHARED_AUDIO_CHUNK_BYTES): string {
  const m = header?.match(/^bytes=(\d+)-(\d*)$/);
  const start = m ? Number(m[1]) : 0;
  const askedEnd = m && m[2] ? Number(m[2]) : Infinity;
  return `bytes=${start}-${Math.min(askedEnd, start + chunk - 1)}`;
}

/** A publicly shared call's audio. Every request (each range a player asks
 *  for) re-checks the link, then streams that range from storage, so turning
 *  the link off stops the audio at the next request and no storage URL ever
 *  reaches the page. */
export const sharedCallAudio = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!token) return notFound();
  const src: string | null = await ctx.runQuery(internal.publicShare.sharedCallAudioSource, { share_token: token });
  if (!src) return notFound();
  const upstream = await fetch(src, { headers: { Range: clampAudioRange(request.headers.get("range")) } });
  if (!upstream.ok) return notFound();
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes" });
  for (const h of ["Content-Type", "Content-Length", "Content-Range"]) {
    const val = upstream.headers.get(h);
    if (val) headers.set(h, val);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});

// A publicly shared call's video (callRecordings.sharedCallVideos): the share
// page's <video> points here, and every request (each range a player asks
// for) re-checks the link and the choice to include video, then redirects to
// a URL into the private bucket. Turning the link off stops the video at the
// next request; no URL into the bucket is ever written into the page.
//
// The URL is signed stable within SHARED_VIDEO_REDIRECT_WINDOW_MS (lib/r2
// stableSigningWindow), so every redirect in a window carries the same
// Location: a player that asks again while scrubbing lands on the object URL
// it already holds, and its ranges come from R2 rather than through here.
// It lives at most two windows, the ten minutes a fresh one had.
//
// Registered only under /cli/, the prefix the Caddy proxy in front of prod
// forwards to HTTP actions today (infra/convex-host/Caddyfile): any other
// path lands on the backend and 404s, so a second address here would be a
// route that never answers.
const SHARED_VIDEO_REDIRECT_WINDOW_MS = 5 * 60_000;
export const sharedCallVideo = httpAction(async (ctx, request) => {
  const u = new URL(request.url);
  const token = u.searchParams.get("token") ?? "";
  const at = Number(u.searchParams.get("at"));
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!token || !Number.isFinite(at)) return notFound();
  const key = await ctx.runQuery(internal.publicShare.sharedCallVideoObject, { share_token: token, at });
  const signed = key ? await callRecordingGetUrl(key, { stable: { at: Date.now(), windowMs: SHARED_VIDEO_REDIRECT_WINDOW_MS } }) : null;
  if (!signed) return notFound();
  return new Response(null, { status: 302, headers: { Location: signed.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
});
