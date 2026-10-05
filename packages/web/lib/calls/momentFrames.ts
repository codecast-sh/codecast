// Frames of a call already drawn on this page, kept as pictures in memory.
//
// A moment's frame (components/calls/CallMomentFrame) is the recording itself,
// seeked. LiveKit writes an MP4's index (the moov) at the END of the file, so
// before a browser draws one frame it makes three requests in turn: the head,
// the tail's index (about 2.4 MB an hour of room video), then the frame's
// data. Recordings are signed `private, no-store` (lib/r2 on the server), so
// nothing of that is reused: a card scrolled far away gives its player back,
// and coming back, or the next hover card of the same moment, would pay the
// whole cost again.
//
// So once a frame has drawn, it is painted onto a canvas (at most
// MAX_FRAME_WIDTH wide) and kept here as a JPEG blob behind an object URL,
// and the next mount of that moment shows an <img> with no network and no
// decoder. Memory only: nothing reaches the disk cache, which is what the
// private signing protects. The video is loaded with crossOrigin so the
// canvas is not tainted, which the recordings bucket's CORS rule (GET and
// HEAD from the app's origins) allows.
//
// A small LRU: an entry read moves to the newest end, the oldest is revoked
// when more than MOMENT_FRAME_LIMIT are held. A call's entries go when the
// viewer loses it (forgetCallRecordings) and an entry goes when its file
// leaves the call (a run deleted: keepCallFrames).

export const MOMENT_FRAME_LIMIT = 48;
const MAX_FRAME_WIDTH = 840;

type Entry = { call: string; recording: string; url: string };
const frames = new Map<string, Entry>();

/** A frame's key: the file and the second into it, to the hundredth (the
 *  precision a moment's video is seeked to). */
export const momentFrameKey = (recordingId: string, seconds: number) => `${recordingId}@${seconds.toFixed(2)}`;

/** The kept picture of a moment, or null. Reading it makes it the newest. */
export function momentFrame(key: string): string | null {
  const e = frames.get(key);
  if (!e) return null;
  frames.delete(key);
  frames.set(key, e);
  return e.url;
}

function put(key: string, entry: Entry): void {
  const old = frames.get(key);
  if (old) URL.revokeObjectURL(old.url);
  frames.delete(key);
  frames.set(key, entry);
  while (frames.size > MOMENT_FRAME_LIMIT) {
    const [oldest, e] = frames.entries().next().value as [string, Entry];
    frames.delete(oldest);
    URL.revokeObjectURL(e.url);
  }
}

/** Keep what a video is showing now as this moment's picture. Quietly does
 *  nothing where it cannot: no canvas (a test DOM), no picture yet, or a
 *  canvas the browser will not read back (a video loaded without CORS). */
export async function keepMomentFrame(key: string, ids: { call: string; recording: string }, video: HTMLVideoElement): Promise<void> {
  if (frames.has(key) || !video.videoWidth || !video.videoHeight) return;
  const width = Math.min(MAX_FRAME_WIDTH, video.videoWidth);
  const height = Math.round((video.videoHeight * width) / video.videoWidth);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.toBlob !== "function") return;
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) return;
    put(key, { ...ids, url: URL.createObjectURL(blob) });
  } catch {
    // A tainted canvas (SecurityError): the frame stays a video next time.
  }
}

/** Drop a call's pictures: every one, or those of files not in `keep` (the
 *  call's files as the server last listed them). */
export function keepCallFrames(call: string, keep?: ReadonlySet<string>): void {
  for (const [key, e] of [...frames]) {
    if (e.call !== call || keep?.has(e.recording)) continue;
    frames.delete(key);
    URL.revokeObjectURL(e.url);
  }
}

/** For tests: how many pictures are held. */
export const momentFrameCount = () => frames.size;
