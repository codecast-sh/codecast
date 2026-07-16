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

export type MachineDeliveredKind = "schedule" | "session" | "teammate";

// Parse a machine-delivered message into a compact entry: which machinery sent it
// (kind), who/what from (source — schedule title, sender session id/name, teammate
// id), and the unwrapped body. Mirrors isMachineDeliveredMessage's three branches.
// Callers may hand in previews/server rows sliced mid-message (getUserMessages cuts
// content at 500 chars), so every branch tolerates a missing closing tag.
export function parseMachineDeliveredMessage(
  rawContent: string | null | undefined,
): { kind: MachineDeliveredKind; source: string; body: string } | null {
  if (!rawContent) return null;
  if (isScheduledTaskMessage(rawContent)) {
    const m = rawContent.match(/<scheduled-task\s+title="([^"]*)"[^>]*>([\s\S]*?)(?:<\/scheduled-task>|$)/);
    const title = (m?.[1] ?? "").replace(/&quot;/g, '"');
    return { kind: "schedule", source: title || "scheduled run", body: (m?.[2] ?? "").trim() };
  }
  if (isSessionMessage(rawContent)) {
    const parsed = parseInboundSessionMessage(rawContent);
    if (parsed) return { kind: "session", source: parsed.name || parsed.from, body: parsed.body };
    const open = rawContent.match(/<session-message\s+from="([^"]*)"(?:\s+name="([^"]*)")?[^>]*>([\s\S]*)$/);
    const body = (open?.[3] ?? "").replace(/<\/session-message>[\s\S]*$/, "").trim();
    return { kind: "session", source: open?.[2] || open?.[1] || "session", body };
  }
  if (isTeammateMessage(rawContent)) {
    const from = rawContent.match(/<teammate-message[^>]*\steammate_id="([^"]*)"/)?.[1];
    const body = stripTeammateFraming(rawContent.replace(/<\/?teammate-message[^>]*>/g, "")).trim();
    return { kind: "teammate", source: from || "teammate", body };
  }
  return null;
}

// --- Spawned schedule-run prompt ------------------------------------------------------
// A spawned run's opening message is the plain-text prompt the daemon hands to
// `claude -p` (taskScheduler.buildPrompt) — there's no wrapper tag, the wire format
// IS the first user message of the run's transcript:
//
//   [Codecast Task: <title>]
//   Task ID: <id>
//   Mode: <propose|apply>
//   <blank>
//   <the actual prompt…>
//   ---                                        (only if context/prior-run present)
//   Context from originating session (<id8>):  (optional)
//   Previous run (<ago>):                      (optional)
//   ---
//   Instructions:
//   - …completion-protocol boilerplate…
//
// Every separator is an exact `---` line. The prompt itself may contain `---`
// lines, so the Instructions tail is found from the END and the context/prior-run
// divider is matched by its label, not position.

export interface SpawnedTaskPrompt {
  title: string;
  taskId: string;
  mode: string;
  prompt: string;
  contextSummary?: string;
  previousRun?: { ago: string; summary: string };
  instructions?: string;
}

const SPAWNED_TASK_HEADER = /^\[Codecast Task: (.*)\]\nTask ID: ([^\n]+)\nMode: ([^\n]+)\n+/;

export function isSpawnedTaskPrompt(rawContent: string | null | undefined): boolean {
  return !!rawContent && SPAWNED_TASK_HEADER.test(rawContent.trim());
}

export function parseSpawnedTaskPrompt(rawContent: string | null | undefined): SpawnedTaskPrompt | null {
  if (!rawContent) return null;
  const text = rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  const header = text.match(SPAWNED_TASK_HEADER);
  if (!header) return null;
  let rest = text.slice(header[0].length);

  let instructions: string | undefined;
  const instrIdx = rest.lastIndexOf("\n---\nInstructions:");
  if (instrIdx !== -1) {
    instructions = rest.slice(instrIdx + "\n---\n".length).replace(/^Instructions:\s*/, "").trim();
    rest = rest.slice(0, instrIdx);
  }

  let contextSummary: string | undefined;
  let previousRun: SpawnedTaskPrompt["previousRun"];
  // buildPrompt puts a blank line between `---` and `Previous run (…)` but none
  // before `Context from originating session` — tolerate any run of newlines.
  const metaDivider = rest.match(/\n---\n+(?=Context from originating session|Previous run \()/);
  if (metaDivider && metaDivider.index !== undefined) {
    const meta = rest.slice(metaDivider.index + metaDivider[0].length);
    rest = rest.slice(0, metaDivider.index);
    const prevMatch = meta.match(/(?:^|\n)Previous run \(([^)]*)\):\n?([\s\S]*)$/);
    if (prevMatch) previousRun = { ago: prevMatch[1], summary: prevMatch[2].trim() };
    const ctxMatch = meta.match(/^Context from originating session[^:]*:\n?([\s\S]*?)(?=\n*Previous run \(|$)/);
    if (ctxMatch && ctxMatch[1].trim()) contextSummary = ctxMatch[1].trim();
  }

  return {
    title: header[1],
    taskId: header[2].trim(),
    mode: header[3].trim(),
    prompt: rest.trim(),
    contextSummary,
    previousRun,
    instructions,
  };
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
  // A spawned schedule run's only "user prompt" is the schedule's — preview the
  // actual task text, not the wire-format header/boilerplate around it.
  const spawned = parseSpawnedTaskPrompt(raw);
  if (spawned) return spawned.prompt || spawned.title;
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
