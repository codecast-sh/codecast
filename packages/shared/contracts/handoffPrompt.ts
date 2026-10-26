// The first message of a handed-off session (`cast handoff --to <agent>`,
// handoff.start). Pure and shared: the CLI prints it for --dry-run, the server
// seeds the new session with it, and the web will show it in its picker, so
// all three read the same text from one function.
//
// The prompt has to stand alone. The new session runs on another agent or
// model and has none of the source's history, so it gets: where it came from,
// what to do first, the model-written brief, the exact commands that open the
// rest of the transcript, and the operator's direction when one was given.

import { AGENT_CLIENTS, fromConvexAgentType } from "./agentClients";

export interface HandoffSourceRef {
  short_id: string;
  title: string | null | undefined;
  /** Convex spelling ("claude_code") or client id ("claude"); both resolve. */
  agent_type: string | null | undefined;
  model?: string | null;
  message_count?: number | null;
  task_short_id?: string | null;
  plan_short_id?: string | null;
}

export interface HandoffPromptInput {
  source: HandoffSourceRef;
  /** The Haiku brief: goal, decisions, verification, open questions, next steps. */
  brief: string;
  /** Operator text from `-m` / stdin. Omitted from the prompt when blank. */
  direction?: string | null;
}

/** "Claude (opus)" / "Codex" — the agent a session ran on, for humans. */
export function describeAgentRun(agent_type: string | null | undefined, model?: string | null): string {
  const name = AGENT_CLIENTS[fromConvexAgentType(agent_type)].displayName;
  const m = (model ?? "").trim();
  return m ? `${name} (${m})` : name;
}

export function composeHandoffPrompt(input: HandoffPromptInput): string {
  const { source } = input;
  const id = source.short_id;
  const lines: string[] = [];

  lines.push(`# Handed off from ${id}: ${sessionTitle(source)}`);
  lines.push("");
  lines.push(`Ran on ${describeAgentRun(source.agent_type, source.model)}.`);
  lines.push("");
  lines.push(
    "This session continues that work. Read the brief below, then pick up at the first next step. " +
    "The transcript is one command away when the brief is not enough.",
  );
  lines.push("");
  lines.push("## Brief");
  lines.push("");
  lines.push(input.brief.trim());
  lines.push("");
  pushReadMore(lines, source, false);

  const direction = (input.direction ?? "").trim();
  if (direction) {
    lines.push("");
    lines.push("## Direction");
    lines.push("");
    lines.push(direction);
  }
  return lines.join("\n") + "\n";
}

function sessionTitle(source: HandoffSourceRef): string {
  return (source.title ?? "").trim() || "Untitled session";
}

// The commands that open the rest of a transcript. Shared by the handoff and
// the context recovery, whose agents both start without the history.
function pushReadMore(lines: string[], source: HandoffSourceRef, recovery: boolean): void {
  const id = source.short_id;
  const count = source.message_count ?? 0;
  const messages = `${count} message${count === 1 ? "" : "s"}`;
  lines.push("## Read more");
  lines.push("");
  lines.push(recovery
    ? `This session's earlier transcript has ${messages}, all still in codecast. Read it in windows, not whole:`
    : `The source transcript has ${messages}. Read it in windows, not whole:`);
  lines.push("");
  lines.push("```bash");
  if (count <= 20) {
    lines.push(`cast read ${id} 1:${Math.max(count, 1)}   # the whole transcript (N:M is a message window)`);
  } else {
    lines.push(`cast read ${id} 1:20   # the opening: goal and first decisions (N:M is a message window)`);
    lines.push(`cast read ${id} ${count - 19}:${count}   # the tail: latest work`);
  }
  lines.push(`cast read ${id} N:M --full   # full tool payloads; the only way to see a StructuredOutput return`);
  lines.push(`cast read ${id} --ask "<question>"   # an answer from ${recovery ? "this session's" : "the source"} transcript, with line citations`);
  lines.push(`cast search "<topic>"   # earlier sessions on the same work, this one included`);
  lines.push(`cast diff ${id}   # files changed, commits, tools used`);
  lines.push(`cast state show ${id}   # the pinned state`);
  if (source.task_short_id) lines.push(`cast task context ${source.task_short_id}   # the bound task; this session is bound to it too`);
  if (source.plan_short_id) lines.push(`cast plan context ${source.plan_short_id}   # the bound plan; this session is bound to it too`);
  lines.push("```");
}

// ── Context recovery ────────────────────────────────────────────────────────
//
// When a session's context fills and cannot be compacted, codecast restarts
// the SAME conversation on a fresh agent and seeds it with this prompt
// (convex handoff.recoverContext). Same id, same role, same thread: the person
// sees one divider and the session carries on. Unlike a handoff, nothing about
// the work moves, so the prompt carries more of it: the role's own opening
// when the session is a standing role, a longer brief, and the latest
// messages verbatim, because the current ask is the one thing a summary must
// never paraphrase.

export const CONTEXT_RECOVERY_HEADING = "# Context recovered";

/** How long after a fresh context park the recovery runs: long enough for a
 *  /compact typed by hand to land first. */
export const CONTEXT_RECOVERY_DELAY_MS = 45_000;

/** A session recovered this recently is left parked for a person: a second
 *  overflow right after a fresh start means the recovery itself is not
 *  working, and looping it would burn turns. */
export const CONTEXT_RECOVERY_COOLDOWN_MS = 30 * 60_000;

export interface RecoveryMessage {
  /** "user" for the person (or the machinery that wakes the session), "assistant" for the agent. */
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ContextRecoveryPromptInput {
  source: HandoffSourceRef;
  brief: string;
  /** The opening a standing role is seated with, re-read from the role now. */
  roleBrief?: string | null;
  /** The newest turns, oldest first, quoted exactly. */
  latest: RecoveryMessage[];
  /** The session's own latest compaction summary, written by its model while
   *  it still had the whole context: quoted whole, never paraphrased. */
  lastSummary?: string | null;
}

/** A fence longer than any backtick run inside the text, so quoted content
 *  with its own code blocks stays one block. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function composeContextRecoveryPrompt(input: ContextRecoveryPromptInput): string {
  const { source } = input;
  const lines: string[] = [];
  lines.push(`${CONTEXT_RECOVERY_HEADING}: ${source.short_id} · ${sessionTitle(source)}`);
  lines.push("");
  lines.push(
    `You are session ${source.short_id}, continuing in a fresh context. The previous context filled up and could not be compacted, ` +
    "so codecast restarted you in the same conversation with this brief. Nothing else changed: same session, same role, same work, " +
    "same people. Carry on as yourself from where the work stopped, without announcing the restart.",
  );
  lines.push("");
  lines.push(
    "The brief is a summary and can be wrong or thin. Before acting on anything it does not settle, read the transcript " +
    "with the commands under Read more; the latest messages below are exact.",
  );
  const role = (input.roleBrief ?? "").trim();
  if (role) {
    lines.push("");
    lines.push("## Role");
    lines.push("");
    lines.push(role);
  }
  const summary = (input.lastSummary ?? "").trim();
  if (summary) {
    lines.push("");
    lines.push("## Your last compaction summary");
    lines.push("");
    lines.push("Written by you when you last compacted. Exact; the brief below covers what came after it.");
    lines.push("");
    const fence = fenceFor(summary);
    lines.push(fence);
    lines.push(summary);
    lines.push(fence);
  }
  lines.push("");
  lines.push("## Brief");
  lines.push("");
  lines.push(input.brief.trim());
  if (input.latest.length) {
    lines.push("");
    lines.push("## Latest messages");
    lines.push("");
    lines.push("Verbatim, oldest first. The last one from the person is what you owe an answer to, unless the brief shows it was already answered.");
    for (const m of input.latest) {
      const fence = fenceFor(m.content);
      lines.push("");
      lines.push(`### ${m.role === "user" ? "User" : "You"} · ${new Date(m.timestamp).toISOString()}`);
      lines.push("");
      lines.push(fence);
      lines.push(m.content.trim());
      lines.push(fence);
    }
  }
  lines.push("");
  pushReadMore(lines, source, true);
  return lines.join("\n") + "\n";
}

/** The prompt a recovery queues when it rebuilt the session's own transcript
 *  from codecast (the first rung, convex handoff.applyContextRecovery): the
 *  agent resumes on its latest compaction summary plus the newest messages
 *  verbatim, so the prompt only says what happened and points at the rest. */
export function composeContextRebuildPrompt(input: { source: HandoffSourceRef; roleBrief?: string | null }): string {
  const { source } = input;
  const lines: string[] = [];
  lines.push(`${CONTEXT_RECOVERY_HEADING}: ${source.short_id} · ${sessionTitle(source)}`);
  lines.push("");
  lines.push(
    `You are session ${source.short_id}. Your context filled up and could not be compacted, so codecast rebuilt this session ` +
    "from codecast's copy of this conversation: your latest compaction summary when there is one, the instructions since it, " +
    "and the newest messages verbatim (the notice at the top of the rebuilt transcript says what was kept). " +
    "Same session, same role, same work, same people. Carry on from where the work stopped, without announcing the restart; " +
    "the newest message from the person that has no answer yet is what you owe.",
  );
  const role = (input.roleBrief ?? "").trim();
  if (role) {
    lines.push("");
    lines.push("## Role");
    lines.push("");
    lines.push(role);
  }
  lines.push("");
  pushReadMore(lines, source, true);
  return lines.join("\n") + "\n";
}

/** Is this the prompt a context recovery seeded the fresh agent with? */
export function isContextRecoveryPrompt(content: string | null | undefined): boolean {
  return !!content && content.trimStart().startsWith(`${CONTEXT_RECOVERY_HEADING}: `);
}
