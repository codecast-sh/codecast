// Detection of user-role messages that machinery delivered into a session
// rather than a human typing them: cross-session `cast send` wrappers,
// inter-agent teammate broadcasts (Claude Code SendMessage), scheduled-task
// injections, and team-chat anchor wakes.
//
// One definition, three consumers that must agree on what "human-typed" means:
// the web/mobile preview surfaces (packages/web/components/sessionMessage.ts,
// which re-exports these and adds the parsers), the profile feed's Typed view
// and the insert-time Sends counter (convex/lib/userSend.ts).

// Normalize the wrappers/control chars the daemon may prepend before a wire
// tag. A session message is injected via tmux, so the input-clearing
// keystrokes (Ctrl-A/Ctrl-K) occasionally leak in as leading control chars,
// and system/task reminders can be appended by the harness.
export function stripInjectionNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^[\x00-\x1f\s]+/, "");
}

// Lightweight detection that a user message is actually an inbound
// session→session message (delivered by `cast send`). Keys off the OPENING tag
// only, so it still fires on a truncated preview (last_message_preview is
// sliced to 200 chars, which can drop the closing tag).
export function isSessionMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<session-message\s+from="/.test(stripInjectionNoise(rawContent));
}

// The multi-agent harness wraps a message from another agent in
// <teammate-message teammate_id="…"> tags, plus a fixed boilerplate lead-in
// ("Another Claude session sent a message:") and trailing disclaimer ("This
// came from another Claude session — … permission laundering.").
export const TEAMMATE_FRAMING_LEADIN = /^Another\s+\S+\s+session sent a message:?/i;
export const TEAMMATE_FRAMING_TRAILER = /This came from another\s+\S+\s+session[\s\S]*$/i;

export function isTeammateMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  if (rawContent.includes("<teammate-message")) return true;
  // SendMessage idle notifications arrive with the same framing but NO tags:
  //   Another Claude session sent a message: {"type":"idle_notification",…}
  return TEAMMATE_FRAMING_LEADIN.test(stripInjectionNoise(rawContent));
}

// Strip the harness's framing boilerplate (machine instruction to the receiving
// agent, not content). Use on the text left over after the <teammate-message>
// tags are removed.
export function stripTeammateFraming(text: string): string {
  return text.replace(TEAMMATE_FRAMING_LEADIN, "").replace(TEAMMATE_FRAMING_TRAILER, "").trim();
}

// True when the only non-tag text is that framing — i.e. a pure teammate
// broadcast with no human-authored words around it.
export function isTeammateFramingOnly(leftover: string): boolean {
  return stripTeammateFraming(leftover).length === 0;
}

// A `cast trigger` injection (the taskScheduler wraps the prompt). The
// <scheduled-task> tag is the frozen wire format from before the triggers
// rename; old transcripts carry it forever.
export function isScheduledTaskMessage(rawContent: string | null | undefined): boolean {
  return !!rawContent && /^<scheduled-task[\s>]/.test(rawContent.trim());
}

// The prompt convex/chat.ts buildAnchorWake hands the anchor session when a
// teammate mentions it in team chat. Plain text, no wrapper tag — the header
// line is the wire format.
export const CHAT_WAKE_HEADER = /^\[codecast team chat — #([^\]\n]+)\]\n/;

export function isChatWakePrompt(rawContent: string | null | undefined): boolean {
  return !!rawContent && CHAT_WAKE_HEADER.test(stripInjectionNoise(rawContent));
}

// Any user-role message delivered by machinery rather than typed by the human:
// a cross-session `cast send` message, an inter-agent teammate broadcast, a
// scheduled-task injection, or a team-chat mention waking the anchor.
export function isMachineDeliveredMessage(rawContent: string | null | undefined): boolean {
  return isSessionMessage(rawContent) || isTeammateMessage(rawContent) || isScheduledTaskMessage(rawContent) || isChatWakePrompt(rawContent);
}

// --- Decision answers (cast decide) ------------------------------------------------
// The human's answer to a `cast decide` question enters the session as a user
// message (store answerDecision). The first line is the answer the agent acts
// on; the trailing tag names the decision it answers and repeats the question,
// so the transcript explains itself and every surface can render the answer
// against its ask (the web bubble links back to the `cast decide` call and
// unfolds the options and context).
//
//   Decision: Keep vendored (current)
//   <cast-decision id="k97…" question="Keep the browser engine vendored?"/>
//
// The tag rides the same message as the text, so tmux injection collapsing
// the newline to a space must not matter: the parser never requires one.
export const DECISION_ANSWER_TAG_RE = /<cast-decision\s+id="([^"]*)"(?:\s+question="([^"]*)")?\s*\/>/;

export interface DecisionAnswerMessage {
  id: string;
  question?: string;
  // The chosen option's label, or the free text the human typed.
  answer: string;
}

function escapeTagAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s*\r?\n\s*/g, " ");
}

function unescapeTagAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function formatDecisionAnswer(a: { id: string; question: string; answer: string }): string {
  return `Decision: ${a.answer}\n<cast-decision id="${a.id}" question="${escapeTagAttr(a.question)}"/>`;
}

export function parseDecisionAnswer(rawContent: string | null | undefined): DecisionAnswerMessage | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const match = text.match(DECISION_ANSWER_TAG_RE);
  if (!match) return null;
  const answer = text.replace(DECISION_ANSWER_TAG_RE, "").trim().replace(/^Decision:\s*/, "");
  return {
    id: match[1],
    question: match[2] !== undefined ? unescapeTagAttr(match[2]) : undefined,
    answer,
  };
}
