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
  const title = (source.title ?? "").trim() || "Untitled session";
  const count = source.message_count ?? 0;
  const lines: string[] = [];

  lines.push(`# Handed off from ${id}: ${title}`);
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
  lines.push("## Read more");
  lines.push("");
  lines.push(
    `The source transcript has ${count} message${count === 1 ? "" : "s"}. Read it in windows, not whole:`,
  );
  lines.push("");
  lines.push("```bash");
  if (count <= 20) {
    lines.push(`cast read ${id} 1:${Math.max(count, 1)}   # the whole transcript (N:M is a message window)`);
  } else {
    lines.push(`cast read ${id} 1:20   # the opening: goal and first decisions (N:M is a message window)`);
    lines.push(`cast read ${id} ${count - 19}:${count}   # the tail: latest work`);
  }
  lines.push(`cast read ${id} N:M --full   # full tool payloads; the only way to see a StructuredOutput return`);
  lines.push(`cast diff ${id}   # files changed, commits, tools used`);
  lines.push(`cast state show ${id}   # the source's pinned state`);
  if (source.task_short_id) lines.push(`cast task context ${source.task_short_id}   # the bound task; this session is bound to it too`);
  if (source.plan_short_id) lines.push(`cast plan context ${source.plan_short_id}   # the bound plan; this session is bound to it too`);
  lines.push("```");

  const direction = (input.direction ?? "").trim();
  if (direction) {
    lines.push("");
    lines.push("## Direction");
    lines.push("");
    lines.push(direction);
  }
  return lines.join("\n") + "\n";
}
