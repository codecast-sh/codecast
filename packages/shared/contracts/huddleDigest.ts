// The huddle digest: the row a finished huddle leaves behind in the place it
// was held. A chat room's huddle posts a chat message; a session room's huddle
// sends the agent a turn. Both carry the same words — the title, a line on how
// long and who, the summary, the action items — written here once so the two
// surfaces and the CLI never drift on what a digest says.
//
// The chat row stores the markdown in `content` and a `call` field naming the
// transcript, so every client paints the summary from the row it already holds
// and fetches the transcript only when a reader opens it. The session turn
// wraps the same markdown in a <huddle-summary> tag whose attributes carry what
// a card needs (the transcript id, title, length, speakers) without parsing
// prose; the body tells the agent how to read the whole transcript. The agent
// gets the summary and a pointer, never the transcript itself.

import { describeClockSpans, parseClockSpans } from "./callRecordings";

export const HUDDLE_DIGEST_CLIENT_ID_PREFIX = "call-digest:";

/** A stretch of the call that was filmed, in call time (ms since it began). */
export type HuddleVideoStretch = { fromMs: number; toMs: number };

export type HuddleDigestInput = {
  title: string | null | undefined;
  startedAt: number;
  endedAt: number | null | undefined;
  speakers: string[];
  summary: string | null | undefined;
  actionItems: string[];
  // Why there is no summary, when there is none.
  summaryStatus: "done" | "failed" | "skipped" | "pending" | null | undefined;
  // The stretches Record filmed (videoStretches), when it was pressed. A
  // huddle filmed in silence, or with transcription off, still leaves a
  // digest: the video is what it left behind.
  video?: readonly HuddleVideoStretch[] | null;
};

export function huddleMinutes(startedAt: number, endedAt: number | null | undefined): number {
  if (!endedAt) return 0;
  return Math.max(1, Math.round((endedAt - startedAt) / 60_000));
}

export function huddleDigestTitle(title: string | null | undefined): string {
  return (title ?? "").trim() || "Huddle";
}

// "12 min huddle with Alice and Bob" — the one line under the title.
export function huddleDigestLead(d: Pick<HuddleDigestInput, "startedAt" | "endedAt" | "speakers">): string {
  const minutes = huddleMinutes(d.startedAt, d.endedAt);
  const length = minutes ? `${minutes} min huddle` : "Huddle";
  const names = d.speakers.filter(Boolean);
  if (names.length === 0) return length;
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${length} with ${who}`;
}

export function huddleSummaryFallback(status: HuddleDigestInput["summaryStatus"]): string {
  return status === "skipped"
    ? "Too short to summarize."
    : status === "failed"
      ? "The summary could not be generated."
      : "Summary pending.";
}

const VIDEO_LINE = /^Recorded on video: ([^\n]+)\.$/;

/** The digest's video line, `Recorded on video: 4:40-7:20.`: plain words for
 *  every reader of the markdown (an agent, the phone, Slack), and the one
 *  place a card reads the stretches back from (parseHuddleDigestContent). */
export function huddleVideoLine(video: readonly HuddleVideoStretch[]): string {
  return `Recorded on video: ${describeClockSpans(video)}.`;
}

// The markdown both surfaces show: a bold title, the lead line, the video
// line when Record was pressed, the summary, the action items. A filmed
// huddle nobody spoke in has no summary to excuse: the video line says what
// it left.
export function formatHuddleDigest(d: HuddleDigestInput): string {
  const parts = [`**${huddleDigestTitle(d.title)}**`, huddleDigestLead(d)];
  const video = d.video?.length ? d.video : null;
  const summary = (d.summary ?? "").trim();
  const body = summary || (video && d.summaryStatus === "skipped" ? "" : huddleSummaryFallback(d.summaryStatus));
  const out = [`${parts[0]} · ${parts[1]}`];
  if (video) out.push("", huddleVideoLine(video));
  if (body) out.push("", body);
  if (d.actionItems.length > 0) {
    out.push("", "Action items:", ...d.actionItems.map((a) => `- ${a}`));
  }
  return out.join("\n");
}

export type HuddleDigestHead = {
  title: string;
  /** "12 min huddle with Alice and Bob" — the line under the title. */
  lead: string;
  /** The digest without its lead line or its video line: the summary and
   *  the action items. */
  body: string;
  /** The filmed stretches, when the huddle was recorded on video. */
  video: HuddleVideoStretch[] | null;
};

/** The video line at the head of a digest body, split off: the stretches and
 *  the body without it. A body with no such line is returned whole. */
function splitVideoLine(body: string): { body: string; video: HuddleVideoStretch[] | null } {
  const nl = body.indexOf("\n");
  const first = (nl === -1 ? body : body.slice(0, nl)).trim();
  const m = VIDEO_LINE.exec(first);
  const video = m ? parseClockSpans(m[1]) : null;
  if (!video) return { body, video: null };
  return { body: nl === -1 ? "" : body.slice(nl).replace(/^\n+/, ""), video };
}

/** The inverse of formatHuddleDigest's first line. A client that holds the chat
 *  row's markdown uses this to paint the title and lead as a header of its own
 *  — a system row about the call — instead of as bold prose inside a person's
 *  message. Returns null when the content is not a digest this formatter wrote,
 *  so callers can fall back to rendering the markdown whole. */
export function parseHuddleDigestContent(content: string): HuddleDigestHead | null {
  const nl = content.indexOf("\n");
  const first = (nl === -1 ? content : content.slice(0, nl)).trim();
  const m = /^\*\*(.+)\*\*\s*·\s*(.+)$/.exec(first);
  if (!m) return null;
  return {
    title: m[1],
    lead: m[2],
    ...splitVideoLine(nl === -1 ? "" : content.slice(nl).replace(/^\n+/, "")),
  };
}

// ── The session wire format ───────────────────────────────────────────────

export type HuddleSummaryTag = {
  transcriptId: string;
  title: string;
  minutes: number;
  speakers: string[];
  // The digest markdown, without the tag or the agent's instructions.
  body: string;
  /** The filmed stretches, when the huddle was recorded on video. */
  video: HuddleVideoStretch[] | null;
};

const ATTR_QUOTE = /"/g;

function attr(value: string): string {
  return value.replace(ATTR_QUOTE, "'").replace(/[\r\n]+/g, " ");
}

export function huddleTranscriptCommand(transcriptId: string): string {
  return `cast call ${transcriptId} --transcript`;
}

// What the agent receives. The digest, then how to read the whole transcript —
// the words themselves stay on the server so a ten minute huddle does not land
// as five thousand tokens of prose the agent did not ask for.
export function formatHuddleSummaryTag(
  transcriptId: string,
  d: HuddleDigestInput,
  // The session already received these words live while the huddle ran (its
  // own room feeds it by default). Saying so is what keeps the digest a
  // record instead of a second ask — an agent told "here is what was decided"
  // twice does the work twice. `callRef` is the call's short id (`cl-42`),
  // what the snap command names it by when it has one.
  opts: { heardLive?: boolean; callRef?: string | null } = {},
): string {
  const digest = formatHuddleDigest(d);
  const video = d.video?.length ? d.video : null;
  const ref = opts.callRef || transcriptId;
  const attrs = [
    `transcript="${attr(transcriptId)}"`,
    `title="${attr(huddleDigestTitle(d.title))}"`,
    `minutes="${huddleMinutes(d.startedAt, d.endedAt)}"`,
    `speakers="${attr(d.speakers.filter(Boolean).join(", "))}"`,
  ].join(" ");
  return [
    `<huddle-summary ${attrs}>`,
    opts.heardLive
      ? "The huddle in this session's room just ended. You already heard it live, line by line, while it ran — this is the same conversation summarized, not a new request. Act on it only where it asks for something you have not done."
      : "A huddle just ended in this session's room. This is its summary; the full speaker-attributed transcript stays on the server.",
    "",
    digest,
    "",
    `A task you file from this huddle takes \`--from-call ${ref}\`, which links it to the call so it shows on the call's page.`,
    `Read the whole transcript with \`${huddleTranscriptCommand(transcriptId)}\` (\`cast call ${transcriptId}\` for the summary and action items alone).`,
    ...(video
      ? [`It was recorded on video: \`cast call snap ${ref}:<line>\` shows the frame at a line said while it was filmed (\`${ref}@m:ss\` at a time).`]
      : []),
    "</huddle-summary>",
  ].join("\n");
}

const TAG_OPEN = /^<huddle-summary\s+([^>]*)>\n?/;

export function isHuddleSummaryTag(text: string | null | undefined): boolean {
  return !!text && TAG_OPEN.test(text.trimStart());
}

// Reads the tag back into what a card renders. Tolerates a missing closing tag
// (previews are sliced mid-message) and returns the digest markdown alone — the
// sentence framing the agent's instructions is not something anybody said.
export function parseHuddleSummaryTag(text: string | null | undefined): HuddleSummaryTag | null {
  if (!text) return null;
  const trimmed = text.trimStart();
  const open = trimmed.match(TAG_OPEN);
  if (!open) return null;
  const attrs: Record<string, string> = {};
  for (const m of open[1].matchAll(/([a-z]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  if (!attrs.transcript) return null;
  let inner = trimmed.slice(open[0].length).replace(/<\/huddle-summary>[\s\S]*$/, "");
  // Drop the lead sentence and the trailing command line; keep the digest.
  inner = inner
    .replace(/^(?:A huddle just ended|The huddle in this session's room just ended)[^\n]*\n\n?/, "")
    .replace(/\n*It was recorded on video: [^\n]*\s*$/, "")
    .replace(/\n*Read the whole transcript with[^\n]*\s*$/, "")
    .replace(/\n*A task you file from this huddle[^\n]*\s*$/, "")
    .trim();
  return {
    transcriptId: attrs.transcript,
    title: attrs.title || "Huddle",
    minutes: Number(attrs.minutes) || 0,
    speakers: (attrs.speakers || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    body: inner,
    video: parseHuddleDigestContent(inner)?.video ?? null,
  };
}
