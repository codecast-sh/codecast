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
    .replace(/^[\x00-\x1f\s]+/, "")
    // The clearing keystrokes sometimes leak a PRINTABLE character instead of a
    // control one, leaving "h<session-message from=…". Drop up to two such
    // characters sitting directly in front of a wire tag, or every predicate
    // below misses the tag and the message reads as something a person typed.
    .replace(WIRE_TAG_JUNK_PREFIX, "");
}

const WIRE_TAG_JUNK_PREFIX =
  /^[^<\s]{1,2}(?=<(?:session-message|agent-message|user-message|teammate-message|scheduled-task)[\s>])/;

// A user-role row that carries tool results is the harness answering the agent's
// tool calls, never something a person typed (typed input always lands as its own
// row). Text on such a row — "Tool loaded." after a ToolSearch, a <fork-boilerplate>
// directive after an Agent fork — is the harness's postscript to the result. The
// daemon parser folds it into the result; rows synced before that still carry it
// as content, so the check must not depend on content being empty.
export function isToolResultCarrier(m: { role?: string; content?: string | null; tool_results?: readonly unknown[] | null }): boolean {
  return m.role === "user" && !!m.tool_results?.length;
}

export function isTurnInterruptionNotice(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  const text = stripInjectionNoise(rawContent);
  return text.startsWith("<turn_aborted>")
    || text.startsWith("The user interrupted the previous turn on purpose.");
}

export function isAgentContextMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  const text = stripInjectionNoise(rawContent);
  return /^<(?:recommended_plugins|environment_context|INSTRUCTIONS|collaboration_mode|app-context)>/.test(text)
    // Codex re-states the thread goal to itself between turns.
    || /^<codex_internal_context[\s>]/.test(text)
    || /^<permissions(?:\s|>)/.test(text)
    // Codex opens a session (or a project without an AGENTS.md) with a
    // "# Project context\nWorking directory: <cwd>" user turn, unflagged.
    || /^# (?:AGENTS\.md instructions|Project context)(?:\s|$)/.test(text);
}

// Lightweight detection that a user message is actually an inbound
// session→session message (delivered by `cast send`). Keys off the OPENING tag
// only, so it still fires on a truncated preview (last_message_preview is
// sliced to 200 chars, which can drop the closing tag).
export function isSessionMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<session-message\s+from="/.test(stripInjectionNoise(rawContent));
}

// A subagent reporting back to the agent that launched it. The Claude Code
// harness delivers the reply as a user-role turn wrapped the same way `cast
// send` wraps a session message, with the subagent's name or id as `from`:
//
//   <agent-message from="review-ct-49528">
//   the body
//   </agent-message>
//
// Same opening-tag-only rule as isSessionMessage, so a truncated preview still
// matches.
export function isAgentMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<agent-message\s+from="/.test(stripInjectionNoise(rawContent));
}

// A person typing into a session that is not their own — the dashboard's
// composer on a teammate's or a bot's session (CollabComposer →
// performSessionSend `direct`). Wrapped so the receiving agent knows a human
// wrote it and who; it is NOT machine-delivered, so previews, the Typed
// counter and the idle notification all treat it as the person's own words.
//
//   <user-message from="Ashot Petrosian">
//   the body
//   </user-message>
export function formatUserMessage(fromName: string, body: string): string {
  return `<user-message from="${fromName.replace(/"/g, "'")}">\n${body}\n</user-message>`;
}

export function isUserMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<user-message\s+from="/.test(stripInjectionNoise(rawContent));
}

// Sender name and body. Tolerates a missing close tag (a preview sliced
// mid-message) and the newline-to-space collapse of a tmux-injected echo that
// never matched its pending row, so the body is trimmed rather than framed.
export function parseUserMessage(rawContent: string | null | undefined): { from: string; body: string } | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const m = text.match(/^<user-message\s+from="([^"]*)"[^>]*>([\s\S]*?)(?:<\/user-message>\s*$|$)/);
  if (!m) return null;
  return { from: m[1].trim(), body: m[2].trim() };
}

// A person's message sent from the org page's staffing pane into the thread
// bound to a proposal (org-staffing.md S18): `orgProposals.say` wraps it as
// <proposal-message proposal="op-N" change="3" from="Name">. The body opens
// with the "About op-N change 3 (…):" header and closes with a reply note for
// the agent; the transcript shows the person's own words under a quote of
// the header, so the bubble reads as theirs and names the row.
export function isProposalMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<proposal-message\s/.test(stripInjectionNoise(rawContent));
}
export function parseProposalMessage(rawContent: string | null | undefined): { proposal: string; change: number | null; from: string; about: string | null; body: string } | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const m = text.match(/^<proposal-message\s+([^>]*)>([\s\S]*?)(?:<\/proposal-message>\s*$|$)/);
  if (!m) return null;
  const attr = (k: string) => { const a = m[1].match(new RegExp(`${k}="([^"]*)"`)); return a ? a[1] : ""; };
  let body = m[2].trim();
  // The trailing reply note is for the agent, not the reader.
  body = body.replace(/\n*\(Reply here;[\s\S]*\)\s*$/, "").trim();
  let about: string | null = null;
  const head = body.match(/^(About \S+ change \d+ \("[^\n]*"\):)\s*\n+/);
  if (head) { about = head[1]; body = body.slice(head[0].length).trim(); }
  const change = attr("change");
  return { proposal: attr("proposal"), change: change ? Number(change) : null, from: attr("from").trim(), about, body };
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

// A standing role's wake frame (convex/orgWakes.ts buildFrame; docs/architecture/
// org-roles-standing.md T3): the opening tag names the role and the time, and
// once delivered the wake's short id and the cause counts.
//
//   <role-wake or-8 wake="rw-12" at="2026-09-15T04:01:55.078Z" causes="9" held="2">
//   ## You
//   …
//   </role-wake>
export const ROLE_WAKE_OPEN_RE = /^<role-wake\s+(or-\d+)((?:\s+[a-z_]+="[^"]*")*)\s*>/;

// Keys off the tag's start only: a preview slice (getUserMessages cuts content
// at 500 chars) can tear the tag itself, and it must still stay off the human rail.
export function isRoleWakeFrame(rawContent: string | null | undefined): boolean {
  return !!rawContent && /^<role-wake\s+or-\d+\b/.test(stripInjectionNoise(rawContent).trim());
}

// A harness <task-notification> — a background task / Monitor / Workflow
// completion the harness injected as a user turn. Keys off the opening tag
// only, same truncated-preview rule as isSessionMessage.
export function isTaskNotificationMessage(rawContent: string | null | undefined): boolean {
  return !!rawContent && rawContent.trim().startsWith("<task-notification>");
}

// A `cast send --raw` report from another session: the body was injected as a
// user-role turn WITHOUT the <session-message> wrapper (the flag exists for
// slash commands like `/model opus`). The receiving transcript then paints it
// as something the human typed. Opening-line only, so a 200-char preview still
// matches; human prompts ("We want to…", a pasted article title) do not.
//
//   Backend B (ct-51438) review fixes: all five of mine fixed…
//   Backend B follow-up: jx71b14 deployed after levelling the tree.
export function parseUnwrappedSessionReport(
  rawContent: string | null | undefined,
): { from: string; body: string; name: string } | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  if (!text || text.startsWith("<")) return null;
  const first = text.split("\n", 1)[0] ?? "";
  const named = (raw: string) => raw.replace(/\s+/g, " ").trim();
  const withTask = first.match(/^([A-Z][\w][\w ./-]{0,40}?)\s*\(ct-\d+\)/);
  if (withTask) {
    const name = named(withTask[1]);
    if (name) return { from: "unknown", body: text, name };
  }
  const followUp = first.match(/^([A-Z][\w][\w ./-]{0,40}?)\s+follow-up\s*:/i);
  if (followUp) {
    const name = named(followUp[1]);
    if (name) return { from: "unknown", body: text, name };
  }
  return null;
}

export function isUnwrappedSessionReport(rawContent: string | null | undefined): boolean {
  return parseUnwrappedSessionReport(rawContent) !== null;
}

// Any user-role message delivered by machinery rather than typed by the human:
// a cross-session `cast send` message, a subagent's report to its parent, an
// inter-agent teammate broadcast, a scheduled-task injection, a harness task
// notification, a team-chat mention waking the anchor, or a `cast send --raw`
// report that lost its session wrapper.
export function isMachineDeliveredMessage(rawContent: string | null | undefined): boolean {
  return isAgentContextMessage(rawContent) || isSessionMessage(rawContent) || isAgentMessage(rawContent) || isTeammateMessage(rawContent) || isScheduledTaskMessage(rawContent) || isTaskNotificationMessage(rawContent) || isChatWakePrompt(rawContent) || isRoleWakeFrame(rawContent) || isUnwrappedSessionReport(rawContent);
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

// Among a conversation's answered decision rows, the one a legacy answer
// bubble (id unknown on the wire) most plausibly answered: the recorded
// answer — the chosen option's label, or the free text — matches, and the
// resolution time sits nearest the message. Shared by the server lookup
// (sessionDecisions.findByAnswer) and the web store scan so both resolve
// the same row.
export function pickAnsweredDecision<
  T extends { options: { label: string }[]; answer_index?: number; answer_text?: string; resolved_at?: number; created_at: number },
>(rows: T[], answer: string, near?: number): T | null {
  const recorded = (r: T) => (r.answer_index !== undefined ? r.options[r.answer_index]?.label : r.answer_text);
  const matches = rows.filter((r) => recorded(r) === answer);
  if (matches.length === 0) return null;
  if (near === undefined) return matches[matches.length - 1];
  const distance = (r: T) => Math.abs((r.resolved_at ?? r.created_at) - near);
  return matches.reduce((best, r) => (distance(r) < distance(best) ? r : best));
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

// The one line the asking agent acts on, per decision kind: single = the
// chosen label, multi = labels joined by ", ", rank = labels joined by " > ",
// form = "key=value; key=value". Shared by the server's finalizeAnswer and the
// web's optimistic answerDecision so the delivered message never differs by
// path. A typed free-text answer wins over any index.
export function decisionAnswerLabel(
  row: { kind?: string; options: { label: string }[] },
  verdict: { answer_index?: number; answer_text?: string; answer_json?: any },
): string | undefined {
  if (verdict.answer_text) return verdict.answer_text;
  const kind = row.kind ?? "single";
  const label = (i: number) => row.options[i]?.label ?? `option ${i + 1}`;
  if (kind === "single") return verdict.answer_index !== undefined ? label(verdict.answer_index) : undefined;
  if (kind === "multi" && Array.isArray(verdict.answer_json)) return verdict.answer_json.map(label).join(", ");
  if (kind === "rank" && Array.isArray(verdict.answer_json)) return verdict.answer_json.map(label).join(" > ");
  if (kind === "form" && verdict.answer_json && typeof verdict.answer_json === "object") {
    return Object.entries(verdict.answer_json)
      .map(([k, val]) => `${k}=${String(val)}`)
      .join("; ");
  }
  return verdict.answer_index !== undefined ? label(verdict.answer_index) : undefined;
}

export function formatDecisionAnswer(a: { id: string; question: string; answer: string }): string {
  return `Decision: ${a.answer}\n<cast-decision id="${a.id}" question="${escapeTagAttr(a.question)}"/>`;
}

export function parseDecisionAnswer(rawContent: string | null | undefined): DecisionAnswerMessage | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const match = text.match(DECISION_ANSWER_TAG_RE);
  if (!match) {
    // Answers sent before the tag shipped were the first line alone: the
    // message is exactly "Decision: <chosen label>". Those transcripts are
    // immutable, so recognize the shape here — id unknown, and single-line
    // only, so a typed message that merely opens with the word stays a
    // normal message. Surfaces resolve the row by conversation + label.
    const legacy = text.trim().match(/^Decision:[ \t]+(\S[^\n]*)$/);
    return legacy ? { id: "", answer: legacy[1].trim() } : null;
  }
  const answer = text.replace(DECISION_ANSWER_TAG_RE, "").trim().replace(/^Decision:\s*/, "");
  return {
    id: match[1],
    question: match[2] !== undefined ? unescapeTagAttr(match[2]) : undefined,
    answer,
  };
}
