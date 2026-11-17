// The agent's copy of a screen recording a person sent it.
//
// The message arrives holding only the recording's tag and the person's own
// words (shared/contracts/screenRecording). The daemon delivering it calls
// this: the call's transcript from the server, a keyframe cut on this machine
// at each line that matters (the same `cast call snap` code, so the frame the
// agent reads is the frame `cl-N@m:ss` names), and the tag rewritten as timed
// lines with their pictures. While the server is still reading the words the
// delivery waits; a recording that is never transcribed still goes, with what
// it has.
import { CODECAST_BASE_URL } from "@codecast/shared/entities";
import {
  framedLines,
  lineMomentMs,
  parseScreenRecordingMessage,
  screenRecordingBrief,
  type BriefSegment,
} from "@codecast/shared/contracts";

/** How long a delivery waits on the server's transcription before sending
 *  what it has. Whisper reads a few minutes of speech in well under this. */
export const SCREEN_RECORDING_WORDS_WAIT_MS = 3 * 60_000;
/** The same wait while the video itself is still uploading (a long
 *  recording on a phone's connection), which has to land before any words. */
export const SCREEN_RECORDING_UPLOAD_WAIT_MS = 15 * 60_000;

export type ScreenRecordingCall = {
  short_id: string | null;
  started_at: number;
  ended_at: number | null;
  transcribe_status: "pending" | "done" | "failed" | null;
  /** The video is in (its file is a ready call file). */
  filmed?: boolean;
  /** Who recorded it. */
  started_by?: string;
  /** Set only on a screen recording: the session it was sent to. */
  screen?: { no_audio?: boolean; conversation_id?: string | null } | null;
  segments: Array<{ t0: number; t1: number; text: string }>;
};

export type BriefDeps = {
  /** The call as `/cli/calls/get` answers it; null when it cannot be read. */
  getCall: (call: string) => Promise<ScreenRecordingCall | null>;
  /** A picture of the screen `atMs` into the call, written locally; null when none could be cut. */
  frameAt: (call: string, atMs: number) => Promise<string | null>;
};

export type BriefOutcome =
  /** Not a screen recording, or already expanded: deliver as it is. */
  | { kind: "unchanged" }
  /** The words are still being read: try again shortly. */
  | { kind: "wait" }
  | { kind: "ready"; text: string; frames: number };

/** The message being delivered: the session it goes into, and who sent it. */
export type DeliveryTarget = { conversationId: string; senderUserId: string };

/** `waitedMs`: how long this message has been waiting on the words so far.
 *
 *  The words and frames are read with the session owner's token, which can
 *  read far more than the people in the session can (a private voice note, a
 *  1:1 huddle). So a tag expands only when it names a screen recording, sent
 *  to this very session, by the person who recorded it. Any other tag is
 *  delivered as it was typed: a teammate's text naming the owner's call must
 *  not make the owner's daemon type that call into a shared session. */
export async function expandScreenRecording(content: string, deps: BriefDeps, waitedMs: number, into: DeliveryTarget): Promise<BriefOutcome> {
  const parsed = parseScreenRecordingMessage(content);
  if (!parsed || parsed.lines.length) return { kind: "unchanged" };
  const call = await deps.getCall(parsed.call);
  if (!call || !call.screen) return { kind: "unchanged" };
  if (!call.screen.conversation_id || call.screen.conversation_id !== into.conversationId) return { kind: "unchanged" };
  if (!call.started_by || call.started_by !== into.senderUserId) return { kind: "unchanged" };
  const pending = call.transcribe_status === "pending";
  if (pending && waitedMs < (call.filmed ? SCREEN_RECORDING_WORDS_WAIT_MS : SCREEN_RECORDING_UPLOAD_WAIT_MS)) return { kind: "wait" };
  const handle = call.short_id ?? parsed.call;
  const segments: BriefSegment[] = call.segments.map((s) => ({ t0: s.t0, t1: s.t1, text: s.text }));
  const frames = new Map<number, string>();
  // One at a time: each is an ffmpeg seek into the same file, and the
  // delivery has a budget; a frame that cannot be cut is left out.
  for (const i of framedLines(segments)) {
    const file = await deps.frameAt(handle, lineMomentMs(segments[i])).catch(() => null);
    if (file) frames.set(i, file);
  }
  const opening = segments.length ? null : await deps.frameAt(handle, 500).catch(() => null);
  const durationMs = Math.max(parsed.durationMs, (call.ended_at ?? call.started_at) - call.started_at);
  const text = screenRecordingBrief({
    ref: { call: handle, transcriptId: parsed.transcriptId, durationMs },
    caption: parsed.caption,
    segments,
    frames,
    words: pending ? "pending" : call.transcribe_status === "failed" ? "failed" : "done",
    noAudio: !!call.screen?.no_audio,
    opening,
  });
  return { kind: "ready", text, frames: frames.size + (opening ? 1 : 0) };
}

/** The deps as the daemon has them: the server over the CLI routes with the
 *  machine's token, and frames cut by `cast call snap`'s own code into the
 *  owner-only scratch directory. */
export function serverBriefDeps(siteUrl: string, apiToken: string, baseUrl: string = CODECAST_BASE_URL): BriefDeps {
  const post = async (route: string, body: Record<string, unknown>) => {
    const res = await fetch(`${siteUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: apiToken, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok || out?.error) throw new Error(`${route}: ${out?.error ?? res.status}`);
    return out;
  };
  return {
    getCall: async (call) => (await post("/cli/calls/get", { transcript_id: call })) as ScreenRecordingCall | null,
    frameAt: async (call, atMs) => {
      const { snapCall, snapMomentRef } = await import("./callSnap.js");
      const res = await snapCall(snapMomentRef(call, atMs), {}, { post, resolveCallId: async (r) => r, baseUrl });
      return res.frames[0]?.path ?? null;
    },
  };
}

type DeliveryOutcome = { wait: true } | { wait: false; content: string };

/** Expansions in progress or done, by message. The delivery loop never
 *  awaits one: it starts the job, holds the message, and finds the result
 *  waiting on a later pass. */
const jobs = new Map<string, { done: DeliveryOutcome | null; startedAt: number }>();
/** A finished job nobody came back for (the message was cancelled) is
 *  dropped after this long. */
const JOB_TTL_MS = 30 * 60_000;

/** What the daemon does with a message as it delivers it, without ever
 *  blocking the loop: the text to type in, or a wait (the frames are being
 *  cut in the background, or the words are still being read on the server).
 *  Anything that is not a screen recording, or that cannot be expanded, goes
 *  as it came: the tag's own text says how to fetch the same. `key` is the
 *  message's id. */
export function screenRecordingForDelivery(
  key: string,
  content: string,
  createdAt: number,
  into: DeliveryTarget,
  server: { siteUrl: string | null; apiToken: string | null },
  log: (line: string) => void = () => {},
  deps?: BriefDeps,
): DeliveryOutcome {
  if (!content.trimStart().startsWith("<screen-recording")) return { wait: false, content };
  const briefDeps = deps ?? (server.siteUrl && server.apiToken ? serverBriefDeps(server.siteUrl, server.apiToken) : null);
  if (!briefDeps) return { wait: false, content };
  const now = Date.now();
  for (const [k, j] of jobs) if (now - j.startedAt > JOB_TTL_MS) jobs.delete(k);
  const job = jobs.get(key);
  if (job) {
    if (!job.done) return { wait: true };
    jobs.delete(key);
    return job.done;
  }
  const entry: { done: DeliveryOutcome | null; startedAt: number } = { done: null, startedAt: now };
  jobs.set(key, entry);
  void expandScreenRecording(content, briefDeps, now - createdAt, into).then(
    (brief) => {
      if (brief.kind === "wait") {
        // The words are not there yet: forget the job, so the next pass asks again.
        jobs.delete(key);
        return;
      }
      if (brief.kind === "ready") log(`expanded with ${brief.frames} frame(s) in ${Date.now() - now} ms`);
      entry.done = brief.kind === "ready" ? { wait: false, content: brief.text } : { wait: false, content };
    },
    (err) => {
      log(`not expanded: ${err instanceof Error ? err.message : String(err)}`);
      entry.done = { wait: false, content };
    },
  );
  return { wait: true };
}
