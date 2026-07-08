// Parser for the session→session message wrapper produced by `cast send`.
// The wire format is defined server-side by formatSessionMessage in
// packages/convex/convex/pendingMessages.ts — keep the tag name in sync.
//
//   <session-message from="jx7c6zk">
//   the body
//   </session-message>

const SESSION_MESSAGE_RE = /<session-message\s+from="([^"]*)"[^>]*>([\s\S]*?)<\/session-message>/;
const SESSION_MESSAGE_NAME_RE = /<session-message\s+from="[^"]*"\s+name="([^"]*)"/;

export function parseSessionMessage(text: string): { from: string; body: string; name?: string } | null {
  if (!text || typeof text !== "string") return null;
  const match = text.match(SESSION_MESSAGE_RE);
  if (!match) return null;
  const name = text.match(SESSION_MESSAGE_NAME_RE)?.[1]?.trim() || undefined;
  return { from: match[1].trim(), body: match[2].trim(), name };
}

// Normalize the wrappers/control chars the daemon may prepend before the tag.
// A session message is injected via tmux, so the input-clearing keystrokes
// (Ctrl-A/Ctrl-K) occasionally leak in as leading control chars, and
// system/task reminders can be appended by the harness.
function stripInjectionNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^[\x00-\x1f\s]+/, "");
}

// Full parse of an inbound session→session message from a raw user-message
// content string. Use where the complete content is available (classification
// and rendering) and the sender/body are needed.
export function parseInboundSessionMessage(
  rawContent: string | null | undefined,
): { from: string; body: string; name?: string } | null {
  if (!rawContent) return null;
  const cleaned = stripInjectionNoise(rawContent);
  if (!cleaned.startsWith("<session-message")) return null;
  return parseSessionMessage(cleaned);
}

// Lightweight detection that a user message is actually an inbound
// session→session message (delivered by `cast send`). Keys off the OPENING tag
// only, so it still fires on a truncated preview (last_message_preview is
// sliced to 200 chars, which can drop the closing tag). Surfaces that present
// "what the human said" — the sticky pill, the message navigator, card
// previews — use this to skip these machine-delivered messages.
export function isSessionMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<session-message\s+from="/.test(stripInjectionNoise(rawContent));
}

// Mirror of the server-side formatter, for any client that wants to construct one
// (and for round-trip tests).
export function formatSessionMessage(fromShortId: string, body: string): string {
  return `<session-message from="${fromShortId}">\n${body}\n</session-message>`;
}

// --- Teammate broadcasts (inter-agent multi-agent harness) ---------------------------
// A separate wire format from `cast send`: the harness wraps a message from another agent
// in <teammate-message teammate_id="…"> tags, plus a fixed boilerplate lead-in ("Another
// Claude session sent a message:") and trailing disclaimer ("This came from another Claude
// session — … permission laundering."). Like a session message, this is machine-delivered,
// not typed by the human, so the "what the human said" surfaces skip it.

const TEAMMATE_FRAMING_LEADIN = /^Another\s+\S+\s+session sent a message:?/i;
const TEAMMATE_FRAMING_TRAILER = /This came from another\s+\S+\s+session[\s\S]*$/i;

export function isTeammateMessage(rawContent: string | null | undefined): boolean {
  return !!rawContent && rawContent.includes("<teammate-message");
}

// Strip the harness's framing boilerplate (machine instruction to the receiving agent, not
// content). Use on the text left over after the <teammate-message> tags are removed.
export function stripTeammateFraming(text: string): string {
  return text.replace(TEAMMATE_FRAMING_LEADIN, "").replace(TEAMMATE_FRAMING_TRAILER, "").trim();
}

// True when the only non-tag text is that framing — i.e. a pure teammate broadcast with no
// human-authored words around it.
export function isTeammateFramingOnly(leftover: string): boolean {
  return stripTeammateFraming(leftover).length === 0;
}

// A `cast schedule` injection (the taskScheduler wraps the prompt; the
// transcript renders it as a ScheduledTaskBlock — same detection pattern as
// conversationProcessor).
export function isScheduledTaskMessage(rawContent: string | null | undefined): boolean {
  return !!rawContent && /^<scheduled-task[\s>]/.test(rawContent.trim());
}

// Any user-role message delivered by machinery rather than typed by the human: a
// cross-session `cast send` message, an inter-agent teammate broadcast, or a
// scheduled-task injection.
export function isMachineDeliveredMessage(rawContent: string | null | undefined): boolean {
  return isSessionMessage(rawContent) || isTeammateMessage(rawContent) || isScheduledTaskMessage(rawContent);
}

// --- Card-preview cleaning ------------------------------------------------------------
// Shared by every "what the human last said" preview surface (web inbox cards, the sticky
// fallback, the mobile inbox/team cards). Lives here — not in a component file — because
// the Expo bundle imports it and must not drag web UI dependencies into Hermes.

const NOISE_PREFIXES = ["[Request interrupted", "This session is being continued", "Your task is to create a detailed summary", "Please continue the conversation", "<task-notification>", "Implement the following plan", "[Codecast import]", 'Background agent "'];

const NOISE_PATTERNS = [
  /toolu_[A-Za-z0-9_-]+/,
  /\/private\/tmp\/claude/,
  /\/tmp\/claude-\d+\//,
  /\.output<\/out/,
  /tasks\/[a-z0-9]+\.output/,
];

export function cleanUserMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // A machine-delivered message (cast send, or an inter-agent teammate broadcast) isn't the
  // user's own prompt — skip it so it never surfaces as the sticky fallback or card preview.
  if (isMachineDeliveredMessage(raw)) return null;
  const cleaned = raw
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  if (!cleaned) return null;
  if (NOISE_PREFIXES.some(p => cleaned.startsWith(p))) return null;
  if (NOISE_PATTERNS.some(p => p.test(cleaned))) return null;
  return cleaned;
}
