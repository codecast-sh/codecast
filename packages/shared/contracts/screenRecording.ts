// A screen recording sent to a session: how the message names it, how the
// agent's copy is written, and which moments of it get a picture.
//
// The recording itself is a recording call (convex/screenRecordings.ts): a
// `cl-N` with its words as transcript segments and its video as the call's
// one screen file. The message a person sends carries only the tag below and
// their own words. Two readers turn the tag into something:
//   - the daemon delivering it (packages/cli screenRecordingBrief) writes the
//     agent's copy: the timed lines, a keyframe beside each, and how to get
//     any other moment (screenRecordingBrief here);
//   - web and the phone draw it as a player over its transcript, read live
//     from the call, so a message sent before the words exist fills in.
// An agent whose daemon predates the tag reads the tag's own text, which says
// the two commands that fetch the same.
import { formatCallTime } from "./callRecordings";

const TAG = "screen-recording";
const OPEN_RE = /^<screen-recording\s+([^>]*)>/;

export type ScreenRecordingRef = {
  /** The call's short id, `cl-42`: what the agent's commands name. */
  call: string;
  /** The call's full id: what the surfaces read it from the store by. */
  transcriptId?: string | null;
  durationMs: number;
};

export type ParsedScreenRecording = ScreenRecordingRef & {
  /** What the person typed with it. */
  caption: string;
  /** The timed lines, when the agent's copy carried them (a daemon expanded it). */
  lines: Array<{ atMs: number; text: string }>;
};

const attr = (s: string) => s.replace(/["<>]/g, "");

function commandsLine(call: string): string {
  return `\`cast call ${call} --transcript\` reads what they said, each line timed; \`cast call snap ${call}:<line>\` shows the screen when a line was said (\`${call}@m:ss\` at a time, \`${call}:1-9\` frames across lines where the screen changed).`;
}

/** The message a send carries: the tag, then the person's own words. */
function openTag(ref: ScreenRecordingRef): string {
  const id = ref.transcriptId ? ` id="${attr(ref.transcriptId)}"` : "";
  return `<${TAG} call="${attr(ref.call)}"${id} duration="${formatCallTime(ref.durationMs)}">`;
}

export function formatScreenRecordingMessage(ref: ScreenRecordingRef, caption: string): string {
  const head = openTag(ref);
  const body = `A screen recording (${ref.call}, ${formatCallTime(ref.durationMs)}): they recorded their screen while talking about it. ${commandsLine(ref.call)}`;
  const words = caption.trim();
  return `${head}\n${body}\n</${TAG}>${words ? `\n\n${words}` : ""}`;
}

/** Parse a "m:ss" / "h:mm:ss" clock into ms. */
function clockMs(s: string): number {
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((t, n) => t * 60 + n, 0) * 1000;
}

const LINE_RE = /^\[(\d+:\d{2}(?::\d{2})?)\]\s+(.*?)(?:\s+\[Image [^\]]+\])*\s*$/;

/** The tag and what came with it, or null for any other message. Takes the
 *  person's message and the agent's expanded copy alike. */
export function parseScreenRecordingMessage(text: string | null | undefined): ParsedScreenRecording | null {
  if (!text) return null;
  const trimmed = text.trimStart();
  const open = trimmed.match(OPEN_RE);
  if (!open) return null;
  const attrs: Record<string, string> = {};
  for (const m of open[1].matchAll(/([a-z]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  if (!/^cl-\d+$/i.test(attrs.call ?? "")) return null;
  const close = trimmed.indexOf(`</${TAG}>`);
  const inner = close >= 0 ? trimmed.slice(open[0].length, close) : trimmed.slice(open[0].length);
  const caption = close >= 0 ? trimmed.slice(close + TAG.length + 3).trim() : "";
  const lines: ParsedScreenRecording["lines"] = [];
  for (const raw of inner.split("\n")) {
    const m = raw.match(LINE_RE);
    if (m) lines.push({ atMs: clockMs(m[1]), text: m[2] });
  }
  return { call: attrs.call.toLowerCase(), transcriptId: attrs.id || null, durationMs: clockMs(attrs.duration ?? "0:00"), caption, lines };
}

/** Words a person says while pointing at something on screen. A line with
 *  one is about what was showing as it was said, so its picture is taken at
 *  that word rather than the line's middle. */
const POINTING = /\b(this|these|that|those|here|there|see|look|right now)\b/i;

export type BriefSegment = { t0: number; t1: number; text: string };

/** The moment a line's picture shows: where in the line the pointing word
 *  falls (speech is close enough to even across a line), else its middle. */
export function lineMomentMs(s: BriefSegment): number {
  const span = Math.max(0, s.t1 - s.t0);
  const hit = s.text.match(POINTING);
  const at = hit?.index != null && s.text.length ? (hit.index + hit[0].length / 2) / s.text.length : 0.5;
  return Math.round(s.t0 + span * at);
}

/** The most pictures one recording sends: enough for a couple of minutes of
 *  talking, few enough that the agent's turn is not mostly images. */
export const SCREEN_RECORDING_MAX_FRAMES = 12;

/** Which lines get a picture: every one, up to the cap; past it the
 *  pointing lines first, then evenly spaced others. Indexes, in order. */
export function framedLines(segments: readonly BriefSegment[], max = SCREEN_RECORDING_MAX_FRAMES): number[] {
  if (segments.length <= max) return segments.map((_, i) => i);
  const pointing = segments.map((s, i) => (POINTING.test(s.text) ? i : -1)).filter((i) => i >= 0);
  const picked = new Set(pointing.slice(0, max));
  const rest = segments.map((_, i) => i).filter((i) => !picked.has(i));
  const room = max - picked.size;
  for (let k = 0; k < room && rest.length; k++) picked.add(rest[Math.floor(((k + 0.5) * rest.length) / room)]);
  return [...picked].sort((a, b) => a - b);
}

/**
 * The agent's copy of a screen recording message: the tag kept (so every
 * surface still knows what it is), its text replaced by what was said, each
 * line timed, with the frame cut at that line beside it.
 *
 * `frames` maps a line's index to a local picture of the screen at
 * lineMomentMs. `noAudio`: the video had no sound track at all.
 */
export function screenRecordingBrief(opts: {
  ref: ScreenRecordingRef;
  caption: string;
  segments: readonly BriefSegment[];
  frames: ReadonlyMap<number, string>;
  /** "done", "pending" or "failed": where the words stand. */
  words: "done" | "pending" | "failed";
  noAudio?: boolean;
  /** A picture of the screen at the start, for a recording with no words to hang one on. */
  opening?: string | null;
}): string {
  const { ref } = opts;
  const head = openTag(ref);
  const intro = `A screen recording (${ref.call}, ${formatCallTime(ref.durationMs)}): they recorded their screen while talking about it.`;
  const out: string[] = [head];
  if (opts.segments.length) {
    out.push(`${intro} What they said, each line at its time in the video. Each [Image path] beside a line is a picture of their screen as they said it: open the ones you need to see what they meant.`, "");
    opts.segments.forEach((s, i) => {
      const frame = opts.frames.get(i);
      out.push(`[${formatCallTime(s.t0)}] ${s.text}${frame ? ` [Image ${frame}]` : ""}`);
    });
    out.push("", `Any other moment: \`cast call snap ${ref.call}@m:ss\` (\`${ref.call}:<line>\` by line, \`--crop\` for small text).`);
  } else {
    const why = opts.noAudio
      ? "The video has no sound (the microphone was off while recording), so there are no words; the screen is all there is."
      : opts.words === "pending"
        ? "Its words are still being transcribed."
        : "No words could be read out of its sound.";
    out.push(`${intro} ${why}${opts.opening ? ` The screen at the start: [Image ${opts.opening}]` : ""}`, commandsLine(ref.call));
  }
  out.push(`</${TAG}>`);
  const words = opts.caption.trim();
  return out.join("\n") + (words ? `\n\n${words}` : "");
}
