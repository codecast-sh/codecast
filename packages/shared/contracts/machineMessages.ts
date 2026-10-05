import type { AreaChange } from "./orgAreas";
// Detection of user-role messages that machinery delivered into a session
// rather than a human typing them: cross-session `cast send` wrappers,
// inter-agent teammate broadcasts (Claude Code SendMessage), scheduled-task
// injections, and team-chat anchor wakes.
//
// One definition, three consumers that must agree on what "human-typed" means:
// the web/mobile preview surfaces (packages/web/components/sessionMessage.ts,
// which re-exports these and adds the parsers), the profile feed's Typed view
// and the insert-time Sends counter (convex/lib/userSend.ts).

export function stripPastedContent(text: string): string {
  return text
    .replace(/<pasted_content(?=[\s>]|$)[^>]*(?:>|$)\r?\n?/g, "")
    .replace(/(?:\r?\n)?<\/pasted_content(?=[\s>]|$)[^>]*(?:>|$)/g, "");
}

// An `@[Title id]` mention in a sent message carries the entity's context
// (a task's description, a plan's body, a doc's content) for the agent. The
// composer appends it after the mention inside this tag, so every display
// surface can show the message as typed while the agent still reads it.
export function wrapMentionContext(markdown: string): string {
  return `\n\n<mention-context>\n${markdown.trim().replace(/^---\n|\n---$/g, "").trim()}\n</mention-context>\n`;
}

// Messages sent before the tag existed carry the same block bare: a `---`
// rule, a `### Doc:`-style heading (or a fenced task/plan block), and a
// closing `> \`cast …\`` pointer followed by another rule.
const LEGACY_MENTION_CONTEXT_RE =
  /\n\n---\n(?=### (?:Task|Plan|Doc|Session|Trigger|Label): |[\s\S]{0,800}?<untrusted-[0-9a-f]+ source=)[\s\S]*?\n> `cast (?:task context|plan show|read|trigger log|doc read|sessions)[^\n]*\n---(?=\n|$)\n?/g;

export function stripMentionContext(text: string): string {
  return text
    .replace(/\n*<mention-context>[\s\S]*?(?:<\/mention-context>\n?|$)/g, "")
    .replace(LEGACY_MENTION_CONTEXT_RE, "");
}

// Normalize the wrappers/control chars the daemon may prepend before a wire
// tag. A session message is injected via tmux, so the input-clearing
// keystrokes (Ctrl-A/Ctrl-K) occasionally leak in as leading control chars,
// and system/task reminders can be appended by the harness.
export function stripInjectionNoise(text: string): string {
  return stripMentionContext(stripPastedContent(text))
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
  /^[^<\s]{1,2}(?=<(?:session-message|agent-message|user-message|task-comment|teammate-message|scheduled-task|session-escalation)[\s>])/;

// A user-role row that carries tool results is the harness answering the agent's
// tool calls, never something a person typed (typed input always lands as its own
// row). Text on such a row — "Tool loaded." after a ToolSearch, a <fork-boilerplate>
// directive after an Agent fork — is the harness's postscript to the result. The
// daemon parser folds it into the result; rows synced before that still carry it
// as content, so the check must not depend on content being empty.
export function isToolResultCarrier(m: { role?: string; content?: string | null; tool_results?: readonly unknown[] | null }): boolean {
  return m.role === "user" && !!m.tool_results?.length;
}

// A poll answer the dashboard sends on the person's behalf (lib/pollPayload:
// a permission prompt's key, a question's option, a "Continue"). It is JSON
// with a `__cc_poll` marker, never words a person typed, so no surface may
// show it as the person's prompt: the feed hides it, the sticky header and
// the navigator skip it.
export function isPollResponsePayload(rawContent: string | null | undefined): boolean {
  const t = stripPastedContent(rawContent ?? "").trimStart();
  if (!t.startsWith("{") || !t.includes("__cc_poll")) return false;
  try { return !!JSON.parse(t).__cc_poll; } catch { return false; }
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

// The wire format for a session→session message (`cast send`, a spawn's
// launch prompt): the one writer, beside its parsers. `from` is the sender's
// short id on a send, its full conversation id on a launch; `name` labels a
// sender with no session of its own; `subagent` marks a launch that may make
// a parent relationship (cli agentPromptOrigin). Readers tolerate either
// attribute (ConversationView classifyUserMessage / SessionMessageBlock).
export function formatSessionMessage(from: string, body: string, opts: { name?: string; subagent?: boolean } = {}): string {
  const nameAttr = opts.name ? ` name="${opts.name.replace(/"/g, "'")}"` : "";
  const subagentAttr = opts.subagent ? ' subagent="true"' : "";
  return `<session-message from="${from}"${nameAttr}${subagentAttr}>\n${body}\n</session-message>`;
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
export function parseProposalMessage(rawContent: string | null | undefined): { proposal: string; change: number | null; ask?: number; from: string; about: string | null; body: string } | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const m = text.match(/^<proposal-message\s+([^>]*)>([\s\S]*?)(?:<\/proposal-message>\s*$|$)/);
  if (!m) return null;
  const attr = (k: string) => { const a = m[1].match(new RegExp(`${k}="([^"]*)"`)); return a ? a[1] : ""; };
  let body = m[2].trim();
  // The trailing reply note is for the agent, not the reader.
  body = body.replace(/\n*\(Reply here;[\s\S]*\)\s*$/, "").trim();
  let about: string | null = null;
  const head = body.match(/^(About \S+ (?:change|ask) \d+ \("[^\n]*"\):)\s*\n+/);
  if (head) { about = head[1]; body = body.slice(head[0].length).trim(); }
  const change = attr("change");
  // `ask` (S19) is the index `orgProposals.decideAsk` takes, from 0; present
  // only on a reply a person sent from an ask's card.
  const ask = attr("ask");
  return { proposal: attr("proposal"), change: change ? Number(change) : null, ...(ask ? { ask: Number(ask) } : {}), from: attr("from").trim(), about, body };
}

// A person's comment on a task, delivered into the session that owns the
// task while it is working (convex tasks.ts deliverCommentToOwner):
// <task-comment task="ct-N" from="Name">. The body opens with the
// "About ct-N ("title"):" header and closes with a reply note for the agent:
// the person reads the task, not the session, so a reply belongs on the task.
// The transcript shows the person's own words under a quote of the header,
// the way a proposal message reads.
export const TASK_COMMENT_TAG = "task-comment";

export function formatTaskCommentMessage(o: { task: string; title: string; from: string; body: string }): string {
  const q = (x: string) => x.replace(/"/g, "'");
  const tail = `(This is a comment on ${o.task}, the task you own. Act on it; when a reply is wanted, answer on the task with \`cast task comment ${o.task} "..."\`, which is where ${q(o.from)} reads.)`;
  return `<${TASK_COMMENT_TAG} task="${o.task}" from="${q(o.from)}">\nAbout ${o.task} ("${q(o.title)}"):\n\n${o.body}\n\n${tail}\n</${TASK_COMMENT_TAG}>`;
}

export function isTaskCommentMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<task-comment\s/.test(stripInjectionNoise(rawContent));
}

export function parseTaskCommentMessage(rawContent: string | null | undefined): { task: string; from: string; about: string | null; body: string } | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const m = text.match(/^<task-comment\s+([^>]*)>([\s\S]*?)(?:<\/task-comment>\s*$|$)/);
  if (!m) return null;
  const attr = (k: string) => { const a = m[1].match(new RegExp(`${k}="([^"]*)"`)); return a ? a[1] : ""; };
  let body = m[2].trim();
  // The trailing reply note is for the agent, not the reader.
  body = body.replace(/\n*\(This is a comment on [\s\S]*\)\s*$/, "").trim();
  let about: string | null = null;
  const head = body.match(/^(About \S+ \("[^\n]*"\):)\s*\n+/);
  if (head) { about = head[1]; body = body.slice(head[0].length).trim(); }
  return { task: attr("task"), from: attr("from").trim(), about, body };
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
  return !!rawContent && /^<scheduled-task[\s>]/.test(stripInjectionNoise(rawContent));
}

// A session that waits, as the trigger that fired for it names it
// (org-staffing.md S28): the facts at the moment it fired. `role` is set when
// the waiting session is a role's own standing session, which speaks as the
// role.
export interface WaitingSession {
  short_id: string;
  title: string;
  /** Why it waits: a needs-input kind, or "blocked" when it declared so. */
  why: string;
  /** When the wait began (ms). */
  since: number;
  role?: string;
  /** The decision it posted (sd-N), when that is what it waits on. */
  decision?: string;
  /** The first line of its pinned state, or the decision's question. */
  state: string;
}

// Who a role is, as its trigger run reminds it (org-staffing.md S25): read
// fresh at firing, so a run never works from a stale idea of its area.
export interface RoleCard {
  handle: string;
  name: string;
  /** A person's name, or "@handle" of the role it reports to. */
  reports_to: string;
  /** What it looks after, by title; empty when the role names no scope. */
  scope: string[];
  charter?: string;
  /** The goals written on the projects it looks after. */
  goals: string[];
  /** The initiatives its work feeds (the ones it owns, and the ones its
   *  projects carry), each with its metric read against the target and the
   *  chain up to the top level goal, so the role knows what its area serves. */
  initiatives?: RoleCardInitiative[];
}
export interface RoleCardInitiative {
  short_id: string;
  title: string;
  /** Each metric as one line: "Weekly active teams: 412 of 1,000, behind (3 days ago)". */
  metrics: string[];
  /** The goals above it, nearest first, by title. */
  chain: string[];
}
/** "Serves: Win the private network (in-4), under Reach 1k teams; Weekly active teams: 412 of 1,000, behind (3 days ago)" */
export function roleCardInitiativeLine(i: RoleCardInitiative): string {
  return `${i.title} (${i.short_id})${i.chain.length ? `, under ${i.chain.join(", under ")}` : ""}${i.metrics.length ? `; ${i.metrics.join("; ")}` : ""}`;
}
/** The card's body as labelled lines, the one wording a wake frame and a
 *  session's org context (`cast org where`) both print. */
export function roleCardLines(r: RoleCard): string[] {
  return [
    r.scope.length ? `Looks after: ${r.scope.join(", ")}` : "Looks after no area of its own: it runs its routine and answers what it is asked.",
    r.charter ? `Charter: ${r.charter}` : "",
    r.goals.length ? `Goals: ${r.goals.join("; ")}` : "",
    ...(r.initiatives ?? []).map((i) => `Serves: ${roleCardInitiativeLine(i)}`),
  ].filter(Boolean);
}
function parseRoleCardInitiativeLine(line: string): RoleCardInitiative {
  const [head, ...metrics] = line.split("; ");
  const m = head.match(/^(.*?) \((in-\d+)\)(?:, under (.*))?$/);
  return m
    ? { title: m[1], short_id: m[2], chain: m[3] ? m[3].split(", under ") : [], metrics }
    : { title: head, short_id: "", chain: [], metrics };
}

export interface ScheduledTaskFrame {
  title: string;
  task_id?: string;
  /** The trigger's short id (tr-42), so the block links what fired it. */
  trigger?: string;
  /** The event that fired it; absent on a scheduled or manual run. */
  event?: string;
  /** What a person focused this run on (orgReview.ts ORG_REVIEW_FOCUSES), as
   *  the run line says it; absent on the routine's own run. */
  focus?: string;
  waiting?: WaitingSession | null;
  /** A change in the company that lasted (org-staffing.md S29), when the
   *  area watch fired the Head of People's trigger for it. */
  change?: AreaChange | null;
  /** Spawned workers that settled, reported to the session they nest under
   *  (workerSettle.ts). `why` is what each settled on: done, blocked,
   *  stopped, permission_blocked or ended. */
  workers?: WaitingSession[];
  role?: RoleCard | null;
  /** The trigger's prompt, and whatever the writer appended for the agent. */
  body: string;
}

const tagAttrs = (pairs: Array<[string, string | undefined]>) =>
  pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}="${escapeTagAttr(v!)}"`).join(" ");
const tagAttr = (head: string, k: string) => {
  const a = head.match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`));
  return a ? unescapeTagAttr(a[1]) : "";
};

/** The one writer of the frame a trigger run arrives in. */
export function formatScheduledTask(f: ScheduledTaskFrame): string {
  const head = tagAttrs([["title", f.title], ["task-id", f.task_id], ["trigger", f.trigger], ["event", f.event], ["focus", f.focus]]);
  const w = f.waiting;
  const waiting = w
    ? `\n<waiting-session ${tagAttrs([["id", w.short_id], ["title", w.title], ["why", w.why], ["since", String(w.since)], ["role", w.role], ["decision", w.decision]])}>${w.state.trim()}</waiting-session>\n\n`
    : "";
  const c = f.change;
  const change = c
    ? `\n<area-change ${tagAttrs(c.kind === "status"
        ? [["kind", c.kind], ["role", c.role_handle], ["name", c.role_name], ["from", c.from ?? undefined], ["to", c.to], ["since", String(c.since)]]
        : [["kind", c.kind], ["project", c.project_id], ["title", c.project_title], ["since", String(c.since)]])}>${c.line.trim()}</area-change>\n\n`
    : "";
  const workers = f.workers?.length
    ? `\n${f.workers.map((w) => `<worker-report ${tagAttrs([["id", w.short_id], ["title", w.title], ["why", w.why], ["since", String(w.since)]])}>${w.state.trim()}</worker-report>`).join("\n")}\n\n`
    : "";
  const r = f.role;
  const roleLines = r ? roleCardLines(r).join("\n") : "";
  const role = r ? `\n<role-card ${tagAttrs([["handle", r.handle], ["name", r.name], ["reports-to", r.reports_to]])}>${roleLines}</role-card>\n` : "";
  return `<scheduled-task ${head}>${role}${waiting}${change}${workers}${f.body}</scheduled-task>`;
}

/** What a spawned worker settled on, in the reader's words (a `<worker-report>` why). */
export const WORKER_SETTLE_WORDS: Record<string, string> = {
  done: "finished",
  blocked: "is blocked",
  stopped: "has stopped",
  permission_blocked: "waits on a permission",
  ended: "ended its turn",
};

/** The one reader. Tolerates a missing closing tag: a preview slice can cut the body. */
export function parseScheduledTask(rawContent: string | null | undefined): ScheduledTaskFrame | null {
  if (!rawContent) return null;
  const m = stripInjectionNoise(rawContent).match(/^<scheduled-task((?:\s+[a-z-]+="[^"]*")*)\s*>([\s\S]*?)(?:<\/scheduled-task>|$)/);
  if (!m) return null;
  let body = m[2];
  let role: RoleCard | null = null;
  const rc = body.match(/^\s*<role-card((?:\s+[a-z-]+="[^"]*")*)\s*>([\s\S]*?)<\/role-card>\s*/);
  if (rc) {
    body = body.slice(rc[0].length);
    const line = (label: string) => rc[2].split("\n").find((l) => l.startsWith(`${label}: `))?.slice(label.length + 2) ?? "";
    const scope = line("Looks after");
    role = {
      handle: tagAttr(rc[1], "handle"),
      name: tagAttr(rc[1], "name"),
      reports_to: tagAttr(rc[1], "reports-to"),
      scope: scope ? scope.split(", ") : [],
      ...(line("Charter") ? { charter: line("Charter") } : {}),
      goals: line("Goals") ? line("Goals").split("; ") : [],
    };
    const serves = rc[2].split("\n").filter((l) => l.startsWith("Serves: ")).map((l) => parseRoleCardInitiativeLine(l.slice("Serves: ".length)));
    if (serves.length) role.initiatives = serves;
  }
  let waiting: WaitingSession | null = null;
  const w = body.match(/^\s*<waiting-session((?:\s+[a-z-]+="[^"]*")*)\s*>([\s\S]*?)<\/waiting-session>\s*/);
  if (w) {
    body = body.slice(w[0].length);
    waiting = {
      short_id: tagAttr(w[1], "id"),
      title: tagAttr(w[1], "title"),
      why: tagAttr(w[1], "why"),
      since: Number(tagAttr(w[1], "since")) || 0,
      ...(tagAttr(w[1], "role") ? { role: tagAttr(w[1], "role") } : {}),
      ...(tagAttr(w[1], "decision") ? { decision: tagAttr(w[1], "decision") } : {}),
      state: w[2].trim(),
    };
  }
  let change: AreaChange | null = null;
  const ch = body.match(/^\s*<area-change((?:\s+[a-z-]+="[^"]*")*)\s*>([\s\S]*?)<\/area-change>\s*/);
  if (ch) {
    body = body.slice(ch[0].length);
    const at = (k: string) => tagAttr(ch[1], k);
    const since = Number(at("since")) || 0;
    change = at("kind") === "unowned_project"
      ? { kind: "unowned_project", project_id: at("project"), project_title: at("title"), since, line: ch[2].trim() }
      : { kind: "status", role_handle: at("role"), role_name: at("name"), from: (at("from") || null) as Extract<AreaChange, { kind: "status" }>["from"], to: at("to") as Extract<AreaChange, { kind: "status" }>["to"], since, line: ch[2].trim() };
  }
  const workers: WaitingSession[] = [];
  for (let wr; (wr = body.match(/^\s*<worker-report((?:\s+[a-z-]+="[^"]*")*)\s*>([\s\S]*?)<\/worker-report>\s*/));) {
    body = body.slice(wr[0].length);
    workers.push({ short_id: tagAttr(wr[1], "id"), title: tagAttr(wr[1], "title"), why: tagAttr(wr[1], "why"), since: Number(tagAttr(wr[1], "since")) || 0, state: wr[2].trim() });
  }
  return {
    title: tagAttr(m[1], "title"),
    ...(tagAttr(m[1], "task-id") ? { task_id: tagAttr(m[1], "task-id") } : {}),
    ...(tagAttr(m[1], "trigger") ? { trigger: tagAttr(m[1], "trigger") } : {}),
    ...(tagAttr(m[1], "event") ? { event: tagAttr(m[1], "event") } : {}),
    ...(tagAttr(m[1], "focus") ? { focus: tagAttr(m[1], "focus") } : {}),
    waiting,
    ...(change ? { change } : {}),
    ...(workers.length ? { workers } : {}),
    role,
    body: body.trim(),
  };
}

// The prompt convex/chat.ts buildAnchorWake hands the anchor session when a
// teammate mentions it in team chat. Plain text, no wrapper tag — the header
// line is the wire format: `[codecast team chat — #<channel> · team <name>]`,
// or `— a direct message · team <name>]` in a DM. Older wakes carry no team.
// Groups: 1 = channel name, 2 = the DM phrase, 3 = team name.
export const CHAT_WAKE_HEADER = /^\[codecast team chat — (?:#([^\]\n]+?)|(a direct message))(?: · team ([^\]\n]+))?\]\n/;

// A mention of a role or session (chat.ts wakeMentionedParties) carries the
// same wake inside <chat-mention channel=… thread=… from=…>. The wake is the
// message; the envelope is routing for the agent.
export function chatWakeText(rawContent: string): string {
  const text = stripInjectionNoise(rawContent);
  const m = text.match(/^<chat-mention\b[^>]*>\n?([\s\S]*?)(?:\n?<\/chat-mention>\s*)?$/);
  return m ? m[1] : text;
}

export function isChatWakePrompt(rawContent: string | null | undefined): boolean {
  return !!rawContent && CHAT_WAKE_HEADER.test(chatWakeText(rawContent));
}

// Claude Code's Workflow tool opens every subagent with two framed user turns:
// the relayed request of the session that ran the workflow, then the task the
// script computed for this agent. Each is one header line of boilerplate, then
// the body indented two spaces. Group 1 names the frame.
export const WORKFLOW_HARNESS_HEADER = /^\[Workflow harness — (user request|computed task)\][^\n]*\n/;

export function parseWorkflowHarnessFrame(rawContent: string | null | undefined): { kind: "user request" | "computed task"; body: string } | null {
  const m = rawContent?.match(WORKFLOW_HARNESS_HEADER);
  if (!m) return null;
  const body = stripPastedContent(rawContent!.slice(m[0].length).replace(/^ {2}/gm, "")).trim();
  return { kind: m[1] as "user request" | "computed task", body };
}

// A harness <task-notification> — a background task / Monitor / Workflow
// completion the harness injected as a user turn. Keys off the opening tag
// only, same truncated-preview rule as isSessionMessage.
export function isTaskNotificationMessage(rawContent: string | null | undefined): boolean {
  return !!rawContent && stripInjectionNoise(rawContent).startsWith("<task-notification>");
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
  // A notice codecast sent a role before notices carried the session
  // envelope (pendingMessages.tellRole): a decision under it, a task handed
  // to it.
  if (/^decision sd-\d+ from a session under you: /.test(first) || /^\S.{0,80} assigned you ct-\d+ "/.test(first)) {
    return { from: "unknown", body: text, name: "codecast" };
  }
  // A worker's name is capitalized ("Backend B follow-up:"); a lowercase
  // opener ("codecast test follow-up: ...") is a person's own prompt.
  const followUp = first.match(/^([A-Z][\w][\w ./-]{0,40}?)\s+[Ff]ollow-up\s*:/);
  if (followUp) {
    const name = named(followUp[1]);
    if (name) return { from: "unknown", body: text, name };
  }
  return null;
}

export function isUnwrappedSessionReport(rawContent: string | null | undefined): boolean {
  return parseUnwrappedSessionReport(rawContent) !== null;
}

// The prompt that seats a standing agent (convex anchors.ts bootstrapMessage):
// "You are the **<role>** (@handle) in <team>" for a role (older threads:
// "You are **<name>**, the standing agent for the **<role>** role"), "You are the Head of People for <workspace>." for the
// head of people (headOfPeoplePrompt.ts), or "..., the **team** anchor for
// <team>" / "the **personal** anchor". The host sends it as an ordinary user message, so
// its own first line is the mark. ONE recogniser: the scope page cuts the
// thread after it (web lib/anchorWindow), and the inbox card's preview, the
// sticky prompt header and the navigator skip it through
// isMachineDeliveredMessage, so no surface can show it as the person's words.
export const BOOTSTRAP_PROMPT_RE = /^\s*You are (\*\*[^*]+\*\*, the (standing agent for|\*\*(team|personal)\*\* (anchor|workspace's standing agent))|the (Head of People|Chief of Staff) for |[^,\n]{1,40}, [^\n]{1,60}'s (Chief of Staff|Executive Assistant) for |the \*\*[^*]+\*\* \(@[a-z0-9-]+\) in )/;

export function isBootstrapPrompt(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return BOOTSTRAP_PROMPT_RE.test(stripInjectionNoise(rawContent));
}

// Any user-role message delivered by machinery rather than typed by the human:
// a cross-session `cast send` message, a subagent's report to its parent, an
// inter-agent teammate broadcast, a scheduled-task injection, a harness task
// notification, a team-chat mention waking the anchor, a `cast send --raw`
// report that lost its session wrapper, or the prompt that seated a standing
// agent.
export function isMachineDeliveredMessage(rawContent: string | null | undefined): boolean {
  return isAgentContextMessage(rawContent) || isSessionMessage(rawContent) || isAgentMessage(rawContent) || isTeammateMessage(rawContent) || isScheduledTaskMessage(rawContent) || isTaskNotificationMessage(rawContent) || isChatWakePrompt(rawContent) || isUnwrappedSessionReport(rawContent) || isBootstrapPrompt(rawContent) || isSessionEscalationMessage(rawContent) || isRoleWakeFrame(rawContent) || isCodexApprovalReviewPrompt(rawContent) || isAgentDefinitionPrompt(rawContent);
}

// The prompt Codex writes into the thread it spawns to assess an approval
// request. Rollouts mark that thread as spawned (cli isCodexProgramLaunch),
// but sessions synced before codecast read the mark carry only this text.
const CODEX_APPROVAL_REVIEW_RE = /^The following is the Codex agent history (?:whose request action you are assessing|added since your last approval assessment)/;

export function isCodexApprovalReviewPrompt(rawContent: string | null | undefined): boolean {
  return !!rawContent && CODEX_APPROVAL_REVIEW_RE.test(stripInjectionNoise(rawContent).trimStart());
}

// An agent or skill definition file handed to a session as its prompt: the
// file's own frontmatter (`name:` then `description:`) opens the message. A
// launcher pastes the file whole; a person writing to an agent does not open
// with its definition.
const AGENT_DEFINITION_RE = /^---\r?\nname:[^\n]*\r?\ndescription:/;

export function isAgentDefinitionPrompt(rawContent: string | null | undefined): boolean {
  return !!rawContent && AGENT_DEFINITION_RE.test(stripInjectionNoise(rawContent).trimStart());
}

// LEGACY: the frame the role wake rail delivered into a role's standing
// session (`<role-wake or-23 wake="rw-967" …>`). The rail is gone (roles wake
// through triggers since 2026-09-25); threads written before then still hold
// the frames, and they are not anything the session's person wrote.
export function isRoleWakeFrame(rawContent: string | null | undefined): boolean {
  return !!rawContent && /^<role-wake[\s>]/.test(stripInjectionNoise(rawContent));
}

// --- A session moving between a role and a person (org-roles-run-work.md R1, revised) ---
// Every move of a session between the role that looked after it and the
// person was written into BOTH threads as one machine message (through the
// ordinary pending message rail, so it synced like any message), and each
// thread renders it as
// an inline divider, never a bubble: the role's face, what moved where, the
// whole line as markdown, the time. LEGACY: the verb that wrote it (`cast
// escalate`) is gone (org-staffing.md S28); threads written before that still
// carry the tag, so only the reader and the caption remain. One tag, three
// moves:
//
//   handed   the role put the session in front of the person through its own
//            card (the default); the child stays nested under the role
//   direct   the child itself became a card in the person's needs input
//   back     the session is the role's again (hand back, --clear)
//
//   <session-escalation move="handed" by="role" role="or-8" handle="calling"
//     name="Calling" avatar="fox" session="jx7abcd" title="Market growth mandate"
//     to="Ashot" at="1790000000000">
//   the line, markdown, as long as the role wrote it
//   </session-escalation>
//
// Attribute order is fixed by the formatter; the parser reads by name, so a
// reader that predates an attribute ignores it. Keys off the opening tag only
// (a 200-char preview can drop the close tag).
export type SessionEscalationMove = "handed" | "direct" | "back";

export interface SessionEscalationMessage {
  move: SessionEscalationMove;
  /** Who moved it: the role from its own session, or the person's gesture. */
  by: "role" | "person";
  /** On a `back` move: the session did not go back under the role, it left
   *  it (its visibility changed and a team role may no longer hold it). */
  left?: boolean;
  role: { short_id: string; handle: string; name: string; avatar?: string };
  session: { short_id: string; title?: string };
  /** The person it moved to (or back from), by display name. */
  to: string;
  at: number;
  /** The reason, markdown. Empty on a hand back with no line. */
  line: string;
}

export function isSessionEscalationMessage(rawContent: string | null | undefined): boolean {
  return !!rawContent && /^<session-escalation\s/.test(stripInjectionNoise(rawContent));
}

export function parseSessionEscalation(rawContent: string | null | undefined): SessionEscalationMessage | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  // The head alone still parses: a preview slice can tear the tag before its
  // close, and the strip only needs the move and the role.
  const m = text.match(/^<session-escalation\s+([^>]*)(?:>([\s\S]*?)(?:<\/session-escalation>\s*$|$)|$)/);
  if (!m) return null;
  const attr = (k: string) => { const a = m[1].match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`)); return a ? unescapeTagAttr(a[1]) : ""; };
  const move = attr("move");
  if (move !== "handed" && move !== "direct" && move !== "back") return null;
  const avatar = attr("avatar");
  const title = attr("title");
  return {
    move,
    by: attr("by") === "person" ? "person" : "role",
    ...(attr("left") === "1" ? { left: true } : {}),
    role: { short_id: attr("role"), handle: attr("handle"), name: attr("name") || attr("handle"), ...(avatar ? { avatar } : {}) },
    session: { short_id: attr("session"), ...(title ? { title } : {}) },
    to: attr("to"),
    at: Number(attr("at")) || 0,
    line: (m[2] ?? "").trim(),
  };
}

/** The caption a divider draws for a move, from the reader's side: the child's
 *  thread names the session by "this session"; the role's thread names it. */
export function sessionEscalationCaption(m: SessionEscalationMessage, opts: { inChild: boolean }): string {
  const what = opts.inChild ? "this session" : m.session.short_id;
  if (m.move === "back") return m.left ? `${what} no longer reports to @${m.role.handle}` : `${what} is back with @${m.role.handle}`;
  const who = m.by === "person" ? m.to : `@${m.role.handle}`;
  const verb = m.move === "direct" ? "put" : "handed";
  const where = m.move === "direct" ? `in front of ${m.to}` : `to ${m.to}`;
  return `${who} ${verb} ${what} ${where}`;
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

// The client id the server's delivery of an answer carries (sessionDecisions
// deliverAnswer), and its reading: the hosted turn engine tells an answer from
// typed input by it, so both sides go through this pair.
const DECISION_ANSWER_CLIENT_PREFIX = "decision-answer:";

export function decisionAnswerClientId(decisionId: string): string {
  return `${DECISION_ANSWER_CLIENT_PREFIX}${decisionId}`;
}

export function decisionIdFromClientId(clientId: string | null | undefined): string | null {
  return clientId?.startsWith(DECISION_ANSWER_CLIENT_PREFIX) ? clientId.slice(DECISION_ANSWER_CLIENT_PREFIX.length) || null : null;
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
