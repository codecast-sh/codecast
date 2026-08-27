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

export const HUDDLE_DIGEST_CLIENT_ID_PREFIX = "call-digest:";

export type HuddleDigestInput = {
  title: string | null | undefined;
  startedAt: number;
  endedAt: number | null | undefined;
  speakers: string[];
  summary: string | null | undefined;
  actionItems: string[];
  // Why there is no summary, when there is none.
  summaryStatus: "done" | "failed" | "skipped" | "pending" | null | undefined;
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

// The markdown both surfaces show: a bold title, the lead line, the summary,
// the action items.
export function formatHuddleDigest(d: HuddleDigestInput): string {
  const parts = [`**${huddleDigestTitle(d.title)}**`, huddleDigestLead(d)];
  const body = (d.summary ?? "").trim() || huddleSummaryFallback(d.summaryStatus);
  const out = [`${parts[0]} · ${parts[1]}`, "", body];
  if (d.actionItems.length > 0) {
    out.push("", "Action items:", ...d.actionItems.map((a) => `- ${a}`));
  }
  return out.join("\n");
}

// ── The session wire format ───────────────────────────────────────────────

export type HuddleSummaryTag = {
  transcriptId: string;
  title: string;
  minutes: number;
  speakers: string[];
  // The digest markdown, without the tag or the agent's instructions.
  body: string;
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
export function formatHuddleSummaryTag(transcriptId: string, d: HuddleDigestInput): string {
  const digest = formatHuddleDigest(d);
  const attrs = [
    `transcript="${attr(transcriptId)}"`,
    `title="${attr(huddleDigestTitle(d.title))}"`,
    `minutes="${huddleMinutes(d.startedAt, d.endedAt)}"`,
    `speakers="${attr(d.speakers.filter(Boolean).join(", "))}"`,
  ].join(" ");
  return [
    `<huddle-summary ${attrs}>`,
    "A huddle just ended in this session's room. This is its summary; the full speaker-attributed transcript stays on the server.",
    "",
    digest,
    "",
    `Read the whole transcript with \`${huddleTranscriptCommand(transcriptId)}\` (\`cast call ${transcriptId}\` for the summary and action items alone).`,
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
    .replace(/^A huddle just ended[^\n]*\n\n?/, "")
    .replace(/\n*Read the whole transcript with[^\n]*\s*$/, "")
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
  };
}
