// The session a change came from is the run's subject (docs/architecture/flows.md
// FL4). A stage that finds work for the change (a failing check, a reviewer's
// finding, a Revise note, a rebase conflict) sends it back to that session as a
// message in its own thread, the session fixes it there, and the run freezes
// the session's change again before the stages run once more. The session also
// hears the gate's answer and how the run ended. Everything here is what the
// runner says to the session and how it reads its change back; the waiting is
// the runner's own station wait (waitOnStation).
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowGraph } from "./types";

export type Subject = { conversationId: string; shortId: string };

/** The session a run's change came from, when the run was started from one. */
export function subjectOf(context: Record<string, string>): Subject | null {
  const conversationId = context["change_conversation"];
  if (!conversationId) return null;
  return { conversationId, shortId: context["change_session"] || conversationId.slice(0, 7) };
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SIGNAL = /\b(error|errors|fail|failed|failing|failure|✗|×|expected|received|panic|exception|traceback|cannot|could not|not found|TS\d{4})\b/i;

/**
 * What a session needs from a long failure: the lines that say what broke, with
 * a line of context each, and the end of the output, where tools sum up. Short
 * output passes whole.
 */
export function failureExcerpt(text: string, maxLines = 60, maxChars = 6000): string {
  const lines = text.replace(ANSI, "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  if (lines.length <= maxLines && lines.join("\n").length <= maxChars) return lines.join("\n");
  const tail = Math.min(20, Math.floor(maxLines / 3));
  const keep = new Set<number>();
  for (let i = lines.length - tail; i < lines.length; i++) if (i >= 0) keep.add(i);
  for (let i = 0; i < lines.length - tail && keep.size < maxLines; i++) {
    if (!SIGNAL.test(lines[i])) continue;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length && keep.size < maxLines) keep.add(j);
  }
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`... (${i - last - 1} lines)`);
    out.push(lines[i]);
    last = i;
  }
  const joined = out.join("\n");
  return joined.length <= maxChars ? joined : `...\n${joined.slice(joined.length - maxChars)}`;
}

/** Where the run's worktree is on disk, read the way `cast ws path` reads it; null when it is gone. */
export async function runWorktreePath(cwd: string, name: string | undefined): Promise<string | null> {
  if (!name) return null;
  const { readState } = await import("../workspace/contract.js");
  const { git } = await import("../wipSnapshot.js");
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => cwd)).trim();
  const at = readState(root, name)?.path ?? path.join(root, ".codecast", "worktrees", name);
  return fs.existsSync(at) ? at : null;
}

/** How a run ended, said to the session it came from. */
export function runEndMessage(graph: WorkflowGraph, opts: { taskId?: string; endLabel: string; failed: boolean; failReason?: string; lastOutput?: string; landed?: boolean }): string {
  const flow = graph.label || graph.name;
  const on = opts.taskId ? ` on ${opts.taskId}` : "";
  if (!opts.failed) {
    const said = (opts.lastOutput ?? "").replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
    return `The ${flow} run${on} is over: ${opts.endLabel}.${said && !said.startsWith("{") ? ` ${said}` : ""} Nothing more is waiting on this session for it.`;
  }
  const why = (opts.failReason ?? "it failed").replace(/^Stopped:\s*/, "").replace(/\.$/, "");
  // A stop after Land leaves the change on the default branch: only what comes after it did not happen.
  const after = opts.landed ? "The change is on the default branch; nothing after this stage ran." : `The change was not shipped. Run it again with \`cast flow run ${graph.name}\` once it is ready.`;
  return `The ${flow} run${on} stopped at ${opts.endLabel}: ${why}. ${after}`;
}

/** Why a run stops when a stage has sent the change back to its session as often as the flow allows. */
export function sentBackWords(stage: string, times: number): string {
  return `${stage} sent the change back ${times} times and it still does not pass.`;
}

/** A gate's answer, said to the session whose change it was about. */
export function gateAnswerMessage(gateLabel: string, choice: string, note: string | undefined): string {
  const words = choice.replace(/^\[.\]\s*/, "").replace(/\s*::.*$/, "").trim();
  return `${gateLabel}: ${words}.${note ? ` Their note: ${note}` : ""} The run goes on; this session will hear how it ends.`;
}
