// Who and what a `cast flow run` is about (flows.md FL4): the session behind it and the one it tells about its
// spawner, the task a session is bound to, and the change a run on a task named alone works on.
import { spawnSync } from "./proc.js";
import type { FlowDeps } from "./flowCommand.js";

/** A session's inbox row, from any ref to it (its codecast id, short id or agent session id); null when unreadable. */
async function sessionRowOf(ref: string, deps: Pick<FlowDeps, "cliPost">): Promise<any | null> {
  const read = await deps.cliPost("/cli/inbox", { session_ids: [ref], show_all: true, limit: 5 }).catch(() => null);
  const rows: any[] = read?.sessions ?? [];
  return rows.find((r) => r.id === ref) ?? (rows.length === 1 ? rows[0] : null);
}

/** A session's own title, when it has one worth naming a change by. */
export async function sessionTitleOf(conversation: string, deps: Pick<FlowDeps, "cliPost">): Promise<string | null> {
  const row = await sessionRowOf(conversation, deps);
  const t = String(row?.short_title || row?.title || "").trim();
  return t && t !== "New Session" ? t.slice(0, 120) : null;
}

/** What `cast workflow run` is told about its spawner. Its own process cannot tell a subagent asked, so a run nobody's
 *  session asked for (asker false) names the session given with --session, else none: never the subagent's parent. */
export function spawnerArgs(asker: string | false | undefined, session: string | boolean | undefined): string[] {
  if (asker !== false) return [];
  return typeof session === "string" ? ["--spawner", session] : ["--no-subject"];
}

/**
 * The run's subject when the change is named (a task, branch or pull request): `asker`, the session that started the
 * run (named with --session, else the one this runs in), so it hears what each stage finds (flows.md FL4). With no
 * asker (a plain shell, a run started over ssh on another machine), the session the task's change came from
 * (`change_session` on /cli/work/get). None when there is neither, or when `asker` is false: a subagent asked, or
 * --no-subject said so, and the task's session is not adopted in its place.
 */
export async function callingSubject(deps: Pick<FlowDeps, "cliPost">, asker: string | undefined | false, task?: string): Promise<{ session: string; conversation: string } | undefined> {
  if (asker === false) return undefined;
  const row = asker ? await sessionRowOf(asker, deps) : null;
  if (row?.id) return { session: String(row.id).slice(0, 7), conversation: String(row.id) };
  const made = task ? (await deps.cliPost("/cli/work/get", { short_id: task }).catch(() => null))?.change_session : null;
  return made?.conversation_id ? { session: String(made.short_id), conversation: String(made.conversation_id) } : undefined;
}

/**
 * What a run on a task named alone works on: the branch an earlier run of the task left in `top` (named for the run's
 * worktree, or a line's), else the calling session's own edits, else nothing it can run on. A branch an earlier run
 * froze from the calling session's edits is that session's change as it was: while the session still holds edits of
 * its own here (`hasOwnEdits`), those are frozen onto it again, so the edits it made since are not left out.
 */
export async function taskChange(top: string, worktree: string, task: string, callingSession: string | undefined, hasOwnEdits: (session: string) => Promise<boolean>): Promise<{ branch: string } | { session: string } | null> {
  const known = [`codecast/${worktree}`, `line-${task}`, `codecast/line-${task}`].find((b) => spawnSync("git", ["-C", top, "rev-parse", "--verify", "--quiet", b]).status === 0);
  if (known === `codecast/${worktree}` && callingSession && (await hasOwnEdits(callingSession))) return { session: callingSession };
  return known ? { branch: known } : callingSession ? { session: callingSession } : null;
}

/** The task a session is bound to (its task pulse, written by `cast task start`), while that task is still open. */
export async function boundOpenTask(agentSession: string | undefined, deps: Pick<FlowDeps, "cliPost">): Promise<string | undefined> {
  const { readTaskPulseFor } = await import("./taskPulse.js");
  const bound = readTaskPulseFor(agentSession)?.task;
  if (!bound) return undefined;
  const row = await deps.cliPost("/cli/work/get", { short_id: bound }).catch(() => null);
  return row && row.status !== "done" && row.status !== "dropped" ? bound : undefined;
}
