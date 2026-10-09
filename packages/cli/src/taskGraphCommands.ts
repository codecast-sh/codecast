// The task graph on the command line (docs/architecture/task-graph.md): one
// blocker grammar for every flag (TG3), the graph lines `cast task show` and
// `context` print (TG12), links that do not block (TG5), and plans that write
// their own order (TG6).

import type { Command } from "commander";
import {
  blockedByLabel,
  blockerLabel,
  holdsBack,
  isPrWaitTarget,
  isTaskBeingWorked,
  isTerminalTaskStatus,
  isWaitId,
  notReadyLabel,
  noWaitOnLine,
  numberedWaveError,
  parkingLine,
  parseBlockerRef,
  parseStepLines,
  planTail,
  readStoredWaitTime,
  stepsFromWaves,
  taskBlockerLine,
  taskRefLine,
  templateSteps,
  topologicalOrder,
  UNBLOCKED_WORD,
  UNKNOWN_BLOCKER_STATUS,
  waitingOnLabel,
  waitMetLabel,
  waitRefLine,
  type Blocker,
  type ChecksOption,
  type GraphTask,
  type MissingTaskBlocker,
  type NotReadyReason,
  type PlanStep,
  type TaskBlocker,
  type TaskWait,
  type TitledTaskBlocker,
  type WaitLabelOptions,
} from "@codecast/shared/tasks";
import { localTimeZone } from "@codecast/shared/time";
import { checkoutRepository, readerWords } from "./checkoutWords.js";
import { c, fmt } from "./colors.js";
import { shq } from "./remote/session-move.js";
import { stdinText } from "./sendBody.js";
import { workOriginStamp } from "./sessionIdentity.js";
import { flagArg, parseWorkspaceKey, teamFlagFor, workspaceScope, type Workspace } from "./resolveWorkspace.js";
import { readTaskPulseFor, type TaskPulse } from "./taskPulse.js";

/** What the commands here need from index.ts. */
export type GraphDeps = {
  cliPost: (path: string, body: Record<string, any>, opts?: { throwOnError?: boolean }) => Promise<any>;
  sessionId: () => string | null;
  cwd: () => string;
  printJson: (value: unknown) => void;
  /** The workspace a read resolves to: `--team`, else the directory's or the active one. */
  workspace: (team?: string) => Promise<{ workspace: "team"; team_id: string } | { workspace: "personal" }>;
  /** A scope's workspace with its team's NAME, for a printed `--team`
   *  (teamFlagFor). `workspaceOfScope` alone yields a bare Convex id, and a
   *  32-character id in a command an agent pastes reads as a blob. */
  namedScope: (scope: { workspace?: string; team_id?: string } | null | undefined) => Promise<Workspace | null>;
};

// ---------------------------------------------------------------------------
// Blocker refs (TG3)
// ---------------------------------------------------------------------------

/** A ref routed to its route: a task edge, a wait, or (removal only) a wait by id. */
export type RoutedRef =
  | { kind: "task"; ref: string }
  | { kind: "wait"; ref: string; barePr: boolean }
  | { kind: "wait_id"; id: string };

/** `--blocked-by` help, on every command that takes it. */
export const BLOCKER_REFS_HELP = `Comma-separated blockers of any kind: a task (ct-12), a PR to merge ("#42", quoted since # starts a shell comment; owner/repo#42, a PR URL; add :checks to wait on green CI), a decision (sd-4) or a time (2h, or 2026-10-14T09:00 — no zone means this machine's zone, so add Z for UTC)`;

/** `--blocked-by ct-4,#42:checks` → each ref, trimmed. The one spelling every
 *  agent surface prints a time wait in carries a comma of its own ("Oct 9,
 *  2026 07:00 UTC"), and `--remove-blocked-by`'s help invites pasting it back,
 *  so a pair of fragments that together read as that spelling is rejoined into
 *  the one ref it names. The grammar for the whole spelling
 *  (`readStoredWaitTime`) is what decides, so the rule holds wherever the
 *  pasted moment sits in the list rather than only when it is the entire value
 *  — an agent that combined refs in one flag would otherwise be refused with
 *  `"Oct 14" is not a blocker` for following the help. Nothing else can be
 *  rejoined: neither fragment of that spelling is a ref on its own. */
export function splitRefs(raw: string | undefined): string[] {
  const refs: string[] = [];
  for (const piece of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const prev = refs.length ? refs[refs.length - 1]! : null;
    const joined = prev === null ? null : `${prev}, ${piece}`;
    if (joined !== null && readStoredWaitTime(joined)) refs[refs.length - 1] = joined;
    else refs.push(piece);
  }
  return refs;
}

/**
 * Where a blocker ref goes: a task to the dependency routes, anything else
 * to the wait routes. Throws the grammar's own error, which lists the
 * accepted forms. `removing` also takes a wait's id.
 */
export function routeBlockerRef(text: string, opts: { now?: number; removing?: boolean } = {}): RoutedRef {
  const given = text.trim();
  // The absolute spelling an agent surface prints a time wait in, pasted back:
  // read it as the ref for that same moment, since it is the only spelling
  // those surfaces offer (TG11). A zone other than the server's UTC fixes no
  // instant, so that one asks for the ref form instead of guessing an offset.
  const stored = readStoredWaitTime(given);
  if (stored && !stored.ref) {
    throw new Error(`"${given}" names a moment but not its instant: write it as a ref (2026-10-14T09:00Z)${opts.removing ? ", or remove the wait by the `id w…` that cast task show and context print after it" : ""}`);
  }
  const trimmed = stored?.ref ?? given;
  // A met time wait stays as history, so removing one may name a past time.
  const parsed = parseBlockerRef(trimmed, { now: opts.now, allowPast: opts.removing });
  if (!parsed.ok) {
    // A wait's id (isWaitId) is checked after the grammar, which it could pass for.
    if (opts.removing && isWaitId(trimmed)) return { kind: "wait_id", id: trimmed };
    throw new Error(opts.removing ? `${parsed.error}. A wait can also be removed by its id (the \`id w…\` that cast task show and context print after a time wait)` : parsed.error);
  }
  if (parsed.kind === "task") return { kind: "task", ref: parsed.ref };
  return { kind: "wait", ref: trimmed, barePr: isPrWaitTarget(parsed) && !parsed.repository };
}


/** What adding waits sends beside the refs: this machine's zone, and this
 *  checkout's repository, the fallback for a bare `#42` when the task's
 *  project names none. */
export function waitScope(refs: Array<Exclude<RoutedRef, { kind: "task" }>>, cwd: string): { time_zone: string; repository?: string } {
  const repository = refs.some((r) => r.kind === "wait" && r.barePr) ? checkoutRepository(cwd) : null;
  return { time_zone: localTimeZone(), ...(repository ? { repository } : {}) };
}

/** The body of `/cli/work/wait` or `/cli/work/unwait` for one routed ref.
 *  Removal sends no repository: a bare `#42` removes that number's waits in
 *  any repository, and the route's validator has no such field. */
export function waitBody(shortId: string, r: Exclude<RoutedRef, { kind: "task" }>, ctx: { cwd: string; sessionId?: string | null; removing?: boolean }): Record<string, any> {
  const body: Record<string, any> = { short_id: shortId, ...(ctx.removing ? { time_zone: localTimeZone() } : waitScope([r], ctx.cwd)) };
  if (r.kind === "wait_id") body.wait_id = r.id;
  else body.ref = r.ref;
  if (ctx.sessionId) body.conversation_id = ctx.sessionId;
  return body;
}

/** "waiting on PR #42", "waiting until 09:00". */
const waitingOn = (w: TaskWait, words: WaitLabelOptions) => waitingOnLabel(w, { ...words, lower: true });

/** What adding a wait printed: met at once, already there, or now waiting.
 *  `words` names PRs as the checkout reads them (checkoutWords). */
export function waitAddedLine(shortId: string, result: { wait: TaskWait; met: boolean; existing?: boolean }, words: WaitLabelOptions = {}): string {
  if (result.existing && !result.met) return `${shortId} was already ${waitingOn(result.wait, words)}`;
  if (result.met) return `${shortId} has nothing to wait for: ${waitMetLabel(result.wait, words)} already`;
  return `${shortId} is ${waitingOn(result.wait, words)}`;
}

/** What adding a task blocker printed, from the blocker as the write answered
 *  for it. A done or dropped blocker holds nothing, so the edge is recorded but
 *  the task is not blocked; neither does a ref that names no task, which only
 *  `create` can answer (`cast task dep` refuses such a ref outright,
 *  requireTaskByRef). Saying so is what keeps a create's own output from
 *  claiming a block `cast task ready` does not see. */
export function depAddedLine(shortId: string, b: TaskBlocker | MissingTaskBlocker): string {
  if ("missing" in b) return `${b.ref} names no task, so it does not block ${shortId} (cast task dep ${shortId} --remove-blocked-by ${b.ref} drops the edge)`;
  return isTerminalTaskStatus(b.status) ? `${b.ref} is already ${b.status}, so it does not block ${shortId}` : `${shortId} is blocked by ${b.ref}`;
}

/** One task blocker as `create` echoed it (`{ref, status?}`), in the one
 *  Blocker shape every graph surface renders. No status means the ref named no
 *  task: `create` ran `assertDependencyEdges` first, which refuses every ref
 *  that resolved outside the creator's own workspace, so the silence is "no
 *  such task" rather than "unreadable" — the same verdict readiness reaches for
 *  the stored ref (`missing`, which holds nothing, TG1). `cast task dep` never
 *  comes here: it answers a status for every edge it accepts, and an older
 *  server's silence there is read as unknown, not as missing. */
export function createdTaskBlocker(b: { ref: string; status?: string }): TaskBlocker | MissingTaskBlocker {
  return b.status ? { kind: "task", ref: b.ref, status: b.status } : { kind: "task", ref: b.ref, missing: true };
}

/** What the blockers of a `cast task create --blocked-by` still hold, as the
 *  one Blocker list every graph surface renders: the task edges the server
 *  echoed with their statuses (a done one holds nothing), then the waits it
 *  added (`addWaitsAtCreate` answers `{wait, met}` for each). The parking line
 *  under a create reads it, so a create and a `cast task dep` judge the same
 *  blocker the same way. */
export function createdHoldingBlockers(result: { blockers?: Array<{ ref: string; status?: string }> | null; waits?: Array<{ wait: TaskWait }> | null } | null | undefined): Blocker[] {
  return [
    ...(result?.blockers ?? []).map(createdTaskBlocker),
    ...(result?.waits ?? []).map((w) => w.wait),
  ].filter(holdsBack);
}

/**
 * Add or remove blockers of any kind on one task: tasks through the
 * dependency routes, waits through the wait routes. Every ref is parsed
 * before the first write, so a ref the grammar rejects changes nothing; one
 * the server refuses stops the run after the earlier ones, each printed `ok`,
 * and names the refs that were never attempted (`unappliedRefsAdvice`).
 */
export async function applyBlockers(deps: GraphDeps, shortId: string, refs: string[], mode: "add" | "remove"): Promise<void> {
  // `cast task dep` calls this for both directions on every run, so one of the
  // two is routinely empty: nothing was written and nothing is read back.
  if (!refs.length) return;
  const routed = refs.map((r) => routeBlockerRef(r, { removing: mode === "remove" }));
  const ctx = { cwd: deps.cwd(), sessionId: deps.sessionId() };
  // An agent's run ends with the parking line below, whose `cast state` pin is
  // absolute by construction (parkingLine forces AGENT_WAIT_WORDS, TG11). So
  // when there is a session, every line here reads in those same words
  // (readerWords): one moment spelled two ways on adjacent lines is what TG11
  // exists to prevent.
  const words = readerWords(ctx.sessionId, ctx.cwd);
  const added: Blocker[] = [];
  for (const [i, r] of routed.entries()) {
    // A ref the server refuses stops the run, and the refs after it were
    // routed but never attempted. Nothing else in the output says so, so this
    // is where the remainder is named — the debt `unfiledStepsAdvice` pays
    // for a half-filed plan.
    try {
      if (r.kind === "task") {
        const result = await deps.cliPost(mode === "add" ? "/cli/work/dep" : "/cli/work/undep", { short_id: shortId, blocked_by: r.ref, ...writerOf(deps) }, { throwOnError: true });
        // An older server answers no status for an edge it accepted; unknown
        // holds, so the task reads as blocked rather than as naming nothing.
        const blocker: TaskBlocker = { kind: "task", ref: r.ref, status: result?.blocker_status ?? UNKNOWN_BLOCKER_STATUS };
        console.log(`${c.green}ok${c.reset} ${mode === "add" ? depAddedLine(shortId, blocker) : `${shortId} is no longer blocked by ${r.ref}`}`);
        if (mode === "add") added.push(blocker);
      } else if (mode === "add") {
        const result = await deps.cliPost("/cli/work/wait", waitBody(shortId, r, ctx), { throwOnError: true });
        console.log(`${c.green}ok${c.reset} ${waitAddedLine(shortId, result, words)}`);
        if (result?.wait) added.push(result.wait);
      } else {
        const result = await deps.cliPost("/cli/work/unwait", waitBody(shortId, r, { ...ctx, removing: true }), { throwOnError: true });
        const removed = (result?.removed ?? []) as TaskWait[];
        for (const w of removed) console.log(`${c.green}ok${c.reset} ${shortId} is no longer ${waitingOn(w, words)}`);
        // Removal by wait id is idempotent on the server, so the web's dispatch
        // retry finds its wait already gone (taskWaits.ts removeWaitCore). Every
        // other ref errors loudly, and this one must too: an agent that removes
        // what it thinks was the last blocker would otherwise read a silent
        // success and park on a wait that is still there.
        if (!removed.length) throw new Error(noWaitRemovedLine(shortId, r));
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      const rest = unappliedRefsAdvice(shortId, refs, i, mode);
      if (rest) console.error(rest);
      process.exit(1);
    }
  }
  const { holding, owns, row } = await holdingAfterBlocking(deps, shortId, added.filter(holdsBack), mode, ctx.sessionId);
  // A removal's `ok` lines say which edges went, which is not the question the
  // removal was asked for: whether the task can move now. The same read-back
  // answers it (TG12's verdict, the web's and the phone's UNBLOCKED_WORD).
  if (mode === "remove") for (const line of removalVerdict(shortId, row, holding, words)) console.log(fmt.muted(line));
  const park = parkAfterBlocking(ctx.sessionId, shortId, holding, readTaskPulseFor(ctx.sessionId), words, owns);
  if (park) console.log(fmt.muted(park));
}

/**
 * What a removal leaves behind: `ct-9 is unblocked` and what to do with it, or
 * what still holds it. The web's task page and the phone print the same verdict
 * over the same list (`UNBLOCKED_WORD`, TG12) and the CLI printed none, so an
 * agent sent here by `failedWaitAdvice` or `stalledWaitAdvice` — remove the
 * wait, then what? — had to spend a `cast task show` to learn whether the
 * removal freed the work.
 *
 * `row` is the task as the server answered it after the write, null when it did
 * not answer: no read, no claim. A task that has since closed waits on nothing
 * whatever it holds (TG1), and the removal was bookkeeping on history, so it
 * gets no verdict. `not_ready` is the server's own reason an unblocked task is
 * still off the frontier (`offFrontierLines`), which is the half of the answer
 * no blocker list holds.
 */
export function removalVerdict(
  shortId: string,
  row: (GraphTask & { short_id?: string | null; not_ready?: NotReadyReason | null }) | null,
  holding: readonly (Blocker & ChecksOption)[],
  words: WaitLabelOptions = {},
): string[] {
  if (!row || isTerminalTaskStatus(row.status)) return [];
  if (holding.length) return [`${shortId} is still blocked by ${holding.map((b) => blockerLabel(b, { ...words, checks: b.checks })).join(", ")}`];
  const off = offFrontierLines({ ...row, short_id: shortId }, row.not_ready);
  // Someone is already on a task being worked, so the next action is the work
  // itself; an open one is claimed. `not_ready` naming another gate (a parent
  // being worked, triage, an ephemeral owner) replaces the claim rather than
  // sitting beside it: it is the reason the claim would not be given.
  if (off.length) return [`${shortId} is ${UNBLOCKED_WORD}`, ...off];
  return [isTaskBeingWorked(row.status)
    ? `${shortId} is ${UNBLOCKED_WORD}, so the work can go on`
    : `${shortId} is ${UNBLOCKED_WORD}: cast task start ${shortId} takes it`];
}

/** What holds the task once a write lands: everything, read back from the
 *  server, not only what this invocation added. An add reads it for the
 *  parking line, a removal for its verdict (`removalVerdict`), and both want
 *  the same answer to the same question, so it is one read in one place.
 *  `cast task context` builds the same sentence from the same whole set
 *  (`holdingBlockers`), and a task already waiting on something else would
 *  otherwise be given two different `cast state` pins by two surfaces, where
 *  `parkHeldLine` exists so the agent reads one. One extra read, only on the
 *  paths that print one. A server that refuses or does not answer leaves an add
 *  with what it just added: a pin naming one of two blockers beats no
 *  instruction to park. A removal is left with nothing and says nothing.
 *
 *  The same read answers who HOLDS the task (`owns`, from the binding on the
 *  conversation), which only the server knows: the pulse file is cleared when
 *  this session closes the task and never when another one takes it over
 *  (`cast task start --take`, a board handoff), and a clearing wakes only the
 *  owner (TG2), so a stale pulse is what promises a wake that never comes.
 *  Undefined from a server that does not say, where the pulse stands. */
async function holdingAfterBlocking(deps: GraphDeps, shortId: string, added: Blocker[], mode: "add" | "remove", sessionId: string | null): Promise<{ holding: Array<Blocker & ChecksOption>; owns?: boolean; row?: any }> {
  if (mode === "add" && (!sessionId || !added.length)) return { holding: added };
  const row = await deps.cliPost("/cli/work/get", { short_id: shortId, ...(sessionId ? { conversation_id: sessionId } : {}) }, { throwOnError: true }).catch(() => null);
  const holding = row ? holdingBlockers(row, row.links) : [];
  // An add keeps what it just wrote when the read says nothing holds: that
  // read can only be staler than the write. A removal has nothing of its own
  // to fall back on, and "nothing holds it" is the answer it asked for.
  return { holding: holding.length || mode === "remove" ? holding : added, ...(row ? { row } : {}), ...(typeof row?.held === "boolean" ? { owns: row.held } : {}) };
}

/** One task a close released: the id and the status it is in now. */
export type ReleasedTask = { short_id: string; status?: string };

/** How many of a closed task's dependents are read back. A task blocking more
 *  than this is a plan, not a dependency, and `cast plan wave` is the read for
 *  one. */
const RELEASE_READ_CAP = 8;

/**
 * What closing a task released: the tasks it blocked that nothing holds any
 * more. The server frees them in the closing transaction (`releaseDependents`)
 * and routes the unblock wake to each dependent's OWNER (TG2), which for work
 * nobody has claimed is nobody — so unless the close says so, the one surface
 * that knows is a read the closer has no reason to run. Every other node in the
 * flow (create, dep, start, ready --claim, plan create --steps) names the next
 * action; the terminal one named none.
 *
 * Two reads, both after the write: the closed task for its `blocks` mirror,
 * then each dependent that is still open. A dependent is claimed released only
 * when it still names this task as a blocker and `holdingBlockers` (TG1's rule,
 * not a copy) finds nothing left holding it. A refused read prints nothing: the
 * close itself is already reported. The close's own cascade is not walked — a
 * subtask closing with its parent is this close's business, not news about
 * other work.
 */
export async function releasedByClose(deps: GraphDeps, shortId: string, opts: { cap?: number } = {}): Promise<{ freed: ReleasedTask[]; more: number }> {
  const cap = opts.cap ?? RELEASE_READ_CAP;
  const row = await deps.cliPost("/cli/work/get", { short_id: shortId }, { throwOnError: true }).catch(() => null);
  if (!row) return { freed: [], more: 0 };
  // Both forms this task can be named by: an older plan row names a blocker by
  // its `_id`, every other writer by its short id.
  const self = [shortId, ...(row._id ? [String(row._id)] : [])];
  const blocked: ReleasedTask[] = row.links?.blocks
    ? row.links.blocks.map((b: { short_id: string; status?: string }) => ({ short_id: b.short_id, status: b.status }))
    : ((row.blocks ?? []) as string[]).map((ref) => ({ short_id: ref }));
  const live = blocked.filter((b) => b.short_id && !isTerminalTaskStatus(b.status));
  const rows = await Promise.all(live.slice(0, cap).map((b) =>
    deps.cliPost("/cli/work/get", { short_id: b.short_id }, { throwOnError: true }).catch(() => null)));
  const freed = rows.flatMap((dep): ReleasedTask[] => {
    if (!dep?.short_id || isTerminalTaskStatus(dep.status)) return [];
    if (!namesBlocker(dep, self)) return [];
    return holdingBlockers(dep, dep.links).length ? [] : [{ short_id: dep.short_id, status: dep.status }];
  });
  return { freed, more: Math.max(0, live.length - cap) };
}

/** Whether `dep` still records one of `self`'s refs as a blocker, so a stale
 *  `blocks` mirror cannot make a close claim a release it did not cause. */
function namesBlocker(dep: { blocked_by?: readonly string[] | null; links?: GraphLinks | null }, self: readonly string[]): boolean {
  const named = [
    ...(dep.links?.blocked_by ?? []).flatMap((b) => (b.kind === "task" ? [b.ref] : [])),
    ...(dep.blocked_by ?? []),
  ];
  return named.some((r) => self.some((mine) => sameTask(r, mine)));
}

/** What a close prints about the work it freed: the ids, and the claim for one
 *  nobody is on yet. Null when it freed nothing, which is the usual case and
 *  needs no line. */
export function releasedByCloseLine(shortId: string, r: { freed: ReleasedTask[]; more: number }): string | null {
  if (!r.freed.length) return null;
  const claimable = r.freed.filter((f) => f.status === "open");
  const claim = claimable.length ? `; cast task start ${claimable[0]!.short_id} takes ${claimable.length === 1 ? "it" : "the first"}` : "";
  // Only when a close blocked more tasks than one read can judge: the ids that
  // were not read are not claimed either way, and `cast task show` lists them.
  const rest = r.more ? ` (${r.more} more it blocked ${r.more === 1 ? "was" : "were"} not read: cast task show ${shortId})` : "";
  return `Unblocked: ${r.freed.map((f) => f.short_id).join(", ")}${claim}${rest}`;
}

/** What a removal that matched nothing says, naming the handle the agent gave
 *  and where its real ones are listed. Only the `wait_id` path reaches it on a
 *  current server, which answers `{removed: []}` there for the web's
 *  idempotent dispatch and throws the same words for a ref (`removeWaitCore`);
 *  the ref branch stays as the fallback for an older one. The sentence itself
 *  lives in shared/tasks (`noWaitOnLine`), so the two packages cannot drift. */
export function noWaitRemovedLine(shortId: string, r: Exclude<RoutedRef, { kind: "task" }>): string {
  return noWaitOnLine(shortId, r.kind === "wait_id" ? `with id ${r.id}` : `on ${r.ref}`);
}

/**
 * The refs a refused write left unattempted, named with the command that
 * applies them. `applyBlockers` routes every ref before the first write and
 * stops at the first refusal, so the remainder is known exactly: without this
 * the output is one `ok`, one error about a different ref, and no word about
 * the rest. `failed` is the index of the ref that was refused; it is named by
 * the error itself, so only what follows it is listed. Null when nothing
 * followed.
 */
export function unappliedRefsAdvice(shortId: string, refs: string[], failed: number, mode: "add" | "remove"): string | null {
  const rest = refs.slice(failed + 1);
  if (!rest.length) return null;
  const one = rest.length === 1;
  const flag = mode === "add" ? "--blocked-by" : "--remove-blocked-by";
  // One command for the whole remainder, the absolute spelling of a time wait
  // ("Oct 9, 2026 07:00 UTC") included: `splitRefs` rejoins that spelling
  // wherever it sits in the list, and `flagArg` quotes a value holding a comma
  // into one shell word.
  const command = `cast task dep ${shortId} ${flag} ${flagArg(rest.join(","))}`;
  const verb = mode === "add" ? "added" : "removed";
  return `${rest.join("; ")} ${one ? "was" : "were"} not ${verb}; retry ${one ? "it" : "them"} with ${command}`;
}

/** Two spellings of one task id ("CT-012", "ct-12"). */
function sameTask(a: string, b: string): boolean {
  const norm = (id: string) => { const p = parseBlockerRef(id); return p.ok && p.kind === "task" ? p.ref : id.toLowerCase(); };
  return norm(a) === norm(b);
}

/** The parking line for the session that HOLDS the task — its pulse names it,
 *  from a `cast task start` — and null for any other reader, since a read of
 *  someone else's blocked task is no instruction to park. The one place
 *  `cast task dep`, `cast task context` and the compaction block agree on who
 *  gets told to park and in what words.
 *
 *  `owns` is the server's answer to the same question (the binding on the
 *  conversation, which the compaction block already reads as `held`), and it
 *  decides when it is given: the pulse is cleared only when this session
 *  closes the task, so after another session took it over it still names a
 *  task this one no longer holds, and the park would wait on a wake that goes
 *  to the new owner alone (TG2). The pulse is the fallback for a caller that
 *  could not ask. */
export function parkHeldLine(pulse: TaskPulse | null, shortId: string, holding: readonly Blocker[], opts: WaitLabelOptions & { underway?: boolean; owns?: boolean } = {}): string | null {
  if (!holding.length) return null;
  const owns = opts.owns ?? (!!pulse?.started && !!pulse.task && sameTask(pulse.task, shortId));
  return owns ? parkingLine(holding, shortId, opts) : null;
}

/** After an agent blocks a task: how to park on it when this session holds
 *  it, else that nothing will wake this session when the blockers clear (a
 *  clearing wakes only the session holding the task, TG2). `words` names PRs
 *  as the lines above it did (checkoutWords), so one PR is not named two ways.
 *  A session that holds the task is by then underway — it started the task and
 *  is far enough in to have found a new blocker — so parking is its call ("If
 *  the work cannot go on until it clears"), the same words the compaction block
 *  gives the same task in the same state. A `cast task create --blocked-by`
 *  calls this too, and a create never holds what it filed, so it takes the
 *  other branch: the warning that nothing will wake it. `owns` is the server's
 *  verdict on who holds the task, when the caller asked for it
 *  (`holdingAfterBlocking`); without it the pulse decides. */
export function parkAfterBlocking(sessionId: string | null, shortId: string, open: Blocker[], pulse: TaskPulse | null, words: WaitLabelOptions = {}, owns?: boolean): string | null {
  if (!sessionId || !open.length) return null;
  return parkHeldLine(pulse, shortId, open, { ...words, underway: true, ...(owns !== undefined ? { owns } : {}) })
    ?? `This session does not hold ${shortId}, so nothing wakes it when ${open.length === 1 ? "this clears" : "these clear"} (cast task start ${shortId} to hold it).`;
}

// ---------------------------------------------------------------------------
// The graph lines of `cast task show` and `context` (TG12)
// ---------------------------------------------------------------------------

type LinkRef = { short_id: string; title?: string; status: string };

/** `tasks.get` / `tasks.context` `links`. Absent on a server older than the graph. */
export type GraphLinks = {
  blocked_by?: TitledTaskBlocker[];
  /** Each still-waiting checks wait's PR `checks_state`, by wait id: what
   *  words it "checks failing" rather than "checks to go green", the same
   *  state the task page and the phone show (TG2). */
  wait_checks?: Record<string, string>;
  blocks?: LinkRef[];
  found_during?: LinkRef | null;
  found_here?: LinkRef[];
  related?: LinkRef[];
  superseded_by?: LinkRef | null;
};

export type GraphSection = { label: string; items: string[]; holds?: boolean };

/** `status` is read for the one rule every surface shares: a closed task waits
 *  on nothing, whatever its rows still say (TG1). Nothing clears a wait on
 *  close, so a done task routinely keeps a `waiting` one as history. */
type GraphTaskRow = { status?: string | null; blocked_by?: string[] | null; blocks?: string[] | null; waits?: TaskWait[] | null };

type Inline = (s: string) => string;
const asIs: Inline = (s) => s;

/** "Superseded by: ct-12 New plan [open]", printed right under the task's
 *  header, as the web shows the replacement at the top (TG12). */
export function supersededLine(links: GraphLinks | null | undefined, inline: Inline = asIs): string | null {
  return links?.superseded_by ? `Superseded by: ${taskRefLine(links.superseded_by, inline)}` : null;
}

/** The task's task blockers, from `links` when the server sent them. A server
 *  older than the graph sends no links; its raw ids are all it can say. */
function blockersOf(t: GraphTaskRow, links: GraphLinks | null | undefined): TitledTaskBlocker[] {
  return links?.blocked_by ?? (t.blocked_by ?? []).map((ref) => ({ kind: "task", ref, status: UNKNOWN_BLOCKER_STATUS }));
}

/** The task's waits, each carrying its PR's `checks_state` when the server
 *  read one (`links.wait_checks`, by wait id). Stamped on the wait rather than
 *  passed beside it, because one task can hold two checks waits in different
 *  states and every reader downstream — the Blocked by line, and the parking
 *  line under it — reads the state off the entry it is rendering. */
function waitsOf(t: GraphTaskRow, links: GraphLinks | null | undefined): Array<TaskWait & ChecksOption> {
  const checks = links?.wait_checks;
  if (!checks) return t.waits ?? [];
  return (t.waits ?? []).map((w) => (checks[w.id] ? { ...w, checks: checks[w.id] } : w));
}

/** What still holds the task back, task blockers and waits together, by
 *  graph.ts's rule rather than a copy of it: what makes the Blocked by section
 *  `holds`, and what the parking line is about. A closed task holds nothing —
 *  the same guard `tasks.list` applies to `open_blockers` — so its leftover
 *  waits read as history rather than as work parked on a PR.
 *
 *  Each wait carries its PR's checks (`waitsOf`), so the parking line this
 *  feeds says red checks need a push (TG10): the one surface that orders a
 *  session dormant must not be the one that cannot see red CI, and
 *  `cast task context` prints that sentence under these very lines. */
export function holdingBlockers(t: GraphTaskRow, links: GraphLinks | null | undefined): Array<Blocker & ChecksOption> {
  if (isTerminalTaskStatus(t.status)) return [];
  return [...blockersOf(t, links), ...waitsOf(t, links)].filter(holdsBack);
}

/**
 * The task's graph, in the web's order and words: Blocked by (tasks with
 * their status, then waits with their state), Blocks, Found during, Found
 * during this, Related. Empty sections are left out. `holds` marks a Blocked
 * by section with something still open; one with nothing open says "cleared".
 * A time wait ends with its id, which `--remove-blocked-by` takes (`waitId`
 * styles it); a PR or decision wait is removed by its target, which is already
 * unique on a task, so its id would be noise. `inline` cleans a title for a
 * reader that feeds the output to an agent. On a closed task nothing holds, so
 * every entry says so (`closed`, the word the phone and the web already drop):
 * a leftover `waiting` wait prints its subject marked `[history]` (a checks
 * wait keeping the `:checks` that tells it from a merge wait on the PR), and a
 * task blocker still open by its own status is marked the same way
 * (`[in_review, history]`), since a bare live status under the section's own
 * "cleared" heading is the one bracket that reads as a hold.
 */
export function taskGraphSections(t: GraphTaskRow, links: GraphLinks | null | undefined, opts: WaitLabelOptions & { inline?: Inline; waitId?: Inline } = {}): GraphSection[] {
  const inline = opts.inline ?? asIs;
  const waitId = opts.waitId ?? asIs;
  const task = (l: LinkRef) => taskRefLine(l, inline);
  // The web's words, plus the state marker a task blocker carries, since this
  // list is read as text ("PR #42 to merge [waiting]"); then, for a time wait,
  // its id — the only kind whose removal needs it (waitRemoveRef).
  const closed = isTerminalTaskStatus(t.status);
  // A checks wait reads by its PR's checks (`wait_checks`), so red CI is as
  // visible here as on the page: without it an agent parks on a wait that
  // has been failing for hours and nothing will ever clear it (TG2).
  const wait = (w: TaskWait & ChecksOption) => `${waitRefLine(w, { ...opts, closed, checks: w.checks, inline })}${w.kind === "time" ? waitId(` · id ${w.id}`) : ""}`;
  const waits = waitsOf(t, links);
  const blockers = blockersOf(t, links);
  // The shared rule (graph.ts), not a copy: a cleared or missing entry holds nothing.
  const holds = holdingBlockers(t, links).length > 0;
  const sections: GraphSection[] = [
    { label: blockedByLabel(holds), items: [...blockers.map((b) => taskBlockerLine(b, inline, { closed })), ...waits.map(wait)], holds },
    { label: "Blocks", items: links?.blocks ? links.blocks.map(task) : (t.blocks ?? []) },
    { label: "Found during", items: links?.found_during ? [task(links.found_during)] : [] },
    { label: "Found during this", items: (links?.found_here ?? []).map(task) },
    { label: "Related", items: (links?.related ?? []).map(task) },
  ];
  return sections.filter((s) => s.items.length);
}

/**
 * Why `cast task ready` leaves an open task out when no blocker says: the
 * server's `not_ready` reason ("Not ready: its parent is being worked"), and
 * whose an ephemeral task is, since only its owner gets it (TG9).
 */
export function offFrontierLines(t: GraphTask & { short_id?: string | null }, reason: NotReadyReason | null | undefined): string[] {
  const lines = reason ? [`Not ready: ${notReadyLabel(t, { ready: false, reason })}`] : [];
  // Every other verdict either explains itself or sits above the Blocked-by
  // lines that name the fix. "not triaged" is the one an agent cannot act on
  // without already knowing which command sets triage_status (tasks.promote),
  // so it gets its own second line the way the ephemeral case does.
  if (reason === "triage") lines.push(`cast task promote ${t.short_id || "<id>"} puts it on the frontier`);
  // Not when "ephemeral" IS the reason: the line above already says the task is
  // the filer's bookkeeping, and this one would say it twice. It is for the
  // OWNER, whose verdict is `ready` and who gets no first line at all.
  if (t.ephemeral && t.status === "open" && reason !== "ephemeral") lines.push(`Ephemeral: only the ${t.created_from_conversation ? "session" : "person"} that filed it gets it from cast task ready`);
  return lines;
}

// ---------------------------------------------------------------------------
// Plans that write their own order (TG6)
// ---------------------------------------------------------------------------

/** A step to create, and any tasks already filed it waits on besides the
 *  steps its `after` names (`stepsFromTitles`). */
export type FiledStep = PlanStep & { blocked_by?: string[] };

/** The grammar of a steps block, on every command that takes one (`cast plan
 *  create --steps`, `cast plan steps`). One constant because the parallel
 *  clause is the half of the wave rule agents get backwards (TG6), and it was
 *  missing from the command used to APPEND a wave. */
export const PLAN_STEPS_GRAMMAR = `one per line ("Title :: what done means" adds a description); a blank line starts a wave that needs the one before (steps in a wave run in parallel)`;

/**
 * How the output of a command that filed a plan's steps closes: the claim that
 * starts execution, staged as a LATER action rather than this turn's next one.
 * Both callers print it (`cast plan create --steps`, `cast plan steps`), and
 * the command that filed the steps is the one the `cast-plan` skill runs — a
 * skill whose own closing rule is to report the plan and stop, because the plan
 * is the review surface a human approves before anything is implemented. A
 * bare "takes the first ready step" as the last line an agent reads is read as
 * the instruction to take it, which is the one act that stage forbids.
 *
 * The `--team` is named outright from the plan's own workspace, never dropped
 * on the grounds that this directory maps there: the line runs later, in a
 * shell whose mapping this process cannot see.
 */
export function planStepsNextAction(planId: string, scope: string): string {
  return `When execution starts, ${c.cyan}cast task ready --plan ${planId}${scope} --claim${c.reset} takes the first ready step`;
}

/**
 * Create `steps` in `planId` in order, each blocked by the steps its `after`
 * names. A step that waits on no other step waits on `roots` instead (the
 * plan's last wave, when appending). Plan steps are the plan's own
 * decomposition, so none is recorded as found while working on the
 * session's task. A refused create throws with what was filed and how to
 * add the rest (`unfiledStepsAdvice`).
 */
export async function createPlanSteps(
  deps: GraphDeps,
  planId: string,
  steps: FiledStep[],
  opts: { roots?: string[]; base?: Record<string, any>; say?: (line: string) => void } = {},
): Promise<Array<{ short_id: string; title: string; blocked_by: string[] }>> {
  const created: Array<{ short_id: string; title: string; blocked_by: string[] }> = [];
  for (const step of steps) {
    const blocked_by = [...(step.after.length ? step.after.map((i) => created[i].short_id) : opts.roots ?? []), ...(step.blocked_by ?? [])];
    const { after: _after, blocked_by: _filed, ...fields } = step;
    let result: any;
    try {
      result = await deps.cliPost("/cli/work/create", {
        ...opts.base,
        ...fields,
        plan_id: planId,
        found_during: "none",
        ...(blocked_by.length ? { blocked_by } : {}),
      }, { throwOnError: true });
    } catch (err) {
      // The advice is read as commands to paste, so its `--team` names the
      // team rather than its id: the roster is only consulted on this path.
      const team = teamFlagFor(await deps.namedScope(opts.base));
      throw new Error(`${(err as Error).message}\n${unfiledStepsAdvice(planId, steps, created, opts.roots ?? [], opts.base, team)}`);
    }
    created.push({ short_id: result.short_id, title: step.title, blocked_by });
    const needs = blocked_by.length ? fmt.muted(`  needs ${blocked_by.join(", ")}`) : "";
    opts.say?.(`  ${c.green}+${c.reset} ${c.cyan}${result.short_id}${c.reset}: ${step.title}${needs}`);
  }
  return created;
}

/**
 * How to add the steps a refused create left unfiled, in their order. Each one
 * whose blockers were all filed gets its own `cast task create` with them,
 * filed where `base` files steps (a person's board, the plan's project and
 * workspace). The steps that need those follow as a `cast plan steps`
 * heredoc in waves, which puts them after the plan's last wave: by then the
 * steps just created. Appending the whole remainder that way would make the
 * rest of a half-filed wave wait on its own filed siblings.
 */
function unfiledStepsAdvice(planId: string, steps: FiledStep[], created: Array<{ short_id: string }>, roots: string[], base: Record<string, any> = {}, team = ""): string {
  const filed = created.length ? `${created.length} of ${steps.length} steps filed (${created.map((s) => s.short_id).join(", ")}); ` : "";
  const rest = steps.slice(created.length);
  const now = rest.filter((s) => s.after.every((i) => i < created.length));
  const human = base.source === "human" ? " --human" : "";
  const where = [
    human,
    // One helper words every printed flag value (flagArg): an id carries no
    // quotes, a name with a space does.
    base.project_id ? ` --project ${flagArg(String(base.project_id))}` : "",
    // One helper words every printed --team (teamFlagFor, resolved by the
    // caller so the team's name is known). These are creates, so the flag
    // stays even when this directory already files there: a write names its
    // workspace rather than inherit whatever the next shell resolves to.
    team,
  ].join("");
  const commands = now.map((s) => {
    const blockers = [...(s.after.length ? s.after.map((i) => created[i].short_id) : roots), ...(s.blocked_by ?? [])];
    return [
      `  cast task create ${shq(s.title)} --plan ${planId} --found-during none${where}`,
      s.description ? ` -d ${shq(s.description)}` : "",
      s.task_type ? ` -t ${s.task_type}` : "",
      s.priority ? ` -p ${s.priority}` : "",
      s.labels?.length ? ` --labels ${shq(s.labels.join(","))}` : "",
      blockers.length ? ` --blocked-by ${blockers.join(",")}` : "",
    ].join("");
  });
  const later = rest.filter((s) => !now.includes(s));
  // Each later step's wave: one past the latest later step it needs.
  const wave = new Map<FiledStep, number>();
  for (const s of later) wave.set(s, Math.max(0, ...s.after.map((i) => steps[i]).filter((p) => wave.has(p)).map((p) => wave.get(p)! + 1)));
  const waves: string[][] = [];
  for (const s of later) (waves[wave.get(s)!] ??= []).push(`${s.title}${s.description ? ` :: ${s.description.replace(/\s*\n\s*/g, " ")}` : ""}`);
  const heredoc = `cast plan steps ${planId}${human} - <<'STEPS'\n${waves.map((w) => w.join("\n")).join("\n\n")}\nSTEPS`;
  const then = later.length ? `\nthen the ${later.length} step${later.length === 1 ? "" : "s"} after them, which go after the plan's last wave:\n${heredoc}` : "";
  return `${filed}"${rest[0].title}" and the steps after it were not. Add them with:\n${commands.join("\n")}${then}`;
}

/**
 * Steps that name what they need by title (`cast plan import`, `decompose`),
 * ordered so each comes after what it needs: a step may name one further
 * down. A name that is no step's title is a task already filed: `filed` maps
 * an existing title to its id, and a task id (ct-12) passes as is; those ride
 * on the step as `blocked_by`. Names that resolve to nothing come back in
 * `unknown`, and the steps of each loop in `loops`, with the edge that closes
 * it dropped; a caller refuses either or says what it left out.
 */
export function stepsFromTitles<S extends Omit<PlanStep, "after"> & { blocked_by?: string[] }>(
  items: S[],
  filed: ReadonlyMap<string, string> = new Map(),
): { steps: Array<Omit<S, "blocked_by"> & FiledStep>; unknown: Array<{ step: string; needs: string }>; loops: string[][] } {
  const index = new Map<string, number>();
  items.forEach((s, i) => { if (!index.has(s.title)) index.set(s.title, i); });
  const unknown: Array<{ step: string; needs: string }> = [];
  const nodes = items.map((item, i) => {
    const inner: string[] = [];
    const outer: string[] = [];
    for (const name of item.blocked_by ?? []) {
      const j = index.get(name);
      if (j !== undefined) { inner.push(`#${j}`); continue; }
      const parsed = parseBlockerRef(name);
      const ref = filed.get(name) ?? (parsed.ok && parsed.kind === "task" ? parsed.ref : null);
      if (ref) outer.push(ref);
      else unknown.push({ step: item.title, needs: name });
    }
    return { short_id: `#${i}`, blocked_by: inner, item, outer };
  });
  const titleOf = (id: string) => items[Number(id.slice(1))].title;
  const loops = topologicalOrder(nodes).cycles.map((cycle) => cycle.map(titleOf));
  const steps = templateSteps(nodes).map(({ task: { item, outer }, blocked_by_indices }) => {
    const { blocked_by: _names, ...fields } = item;
    return { ...fields, after: blocked_by_indices, ...(outer.length ? { blocked_by: outer } : {}) };
  });
  return { steps, unknown, loops };
}

/** `--steps`/`steps` input as steps, refusing an empty list with the form,
 *  and numbered lines in one wave (numberedWaveError). */
export function stepsFromText(text: string): PlanStep[] {
  const waves = parseStepLines(text);
  const numbered = numberedWaveError(waves);
  if (numbered) throw new Error(numbered);
  const steps = stepsFromWaves(waves.map((wave) => wave.map((l) => l.text)));
  if (!steps.length) throw new Error("No steps given: one per line, a blank line between waves (steps in a wave run in parallel; each wave needs the one before)");
  return steps;
}

/** A saved template's steps (plan_templates.task_templates). */
export function stepsFromTemplate(template: { task_templates: Array<{ title: string; description?: string; task_type?: string; priority?: string; blocked_by_indices?: number[]; estimated_minutes?: number }> }): PlanStep[] {
  return template.task_templates.map(({ blocked_by_indices, ...t }, i) => ({ ...t, after: (blocked_by_indices ?? []).filter((j) => j < i) }));
}

/** Built-in plan templates: each step needs the one before it. */
const BUILTIN_TEMPLATES: Record<string, Array<{ title: string; description: string; labels: string[] }>> = {
  "plan-implement-verify": [
    { title: "Research and plan approach", description: "Investigate the codebase, understand requirements, and outline the implementation strategy.", labels: ["planning"] },
    { title: "Implement core changes", description: "Build the feature or fix based on the plan.", labels: ["coding"] },
    { title: "Write tests", description: "Add unit and integration tests covering the implementation.", labels: ["testing"] },
    { title: "Verify and polish", description: "Run full test suite, typecheck, review diff, fix issues.", labels: ["verification"] },
  ],
  "implement-review-fix": [
    { title: "Initial implementation", description: "Build the feature or fix.", labels: ["coding"] },
    { title: "Self-review and identify issues", description: "Review the diff, run tests, identify problems.", labels: ["review"] },
    { title: "Fix identified issues", description: "Address all issues found during review.", labels: ["coding"] },
    { title: "Final verification", description: "Confirm all issues resolved, tests pass, code is clean.", labels: ["verification"] },
  ],
  "full-lifecycle": [
    { title: "Research and scope", description: "Understand the problem space, read relevant code, define scope.", labels: ["planning"] },
    { title: "Design approach", description: "Outline the technical approach, identify risks and dependencies.", labels: ["planning"] },
    { title: "Implement", description: "Build the feature following the design.", labels: ["coding"] },
    { title: "Test", description: "Write and run tests.", labels: ["testing"] },
    { title: "Review", description: "Self-review the changes, check for issues.", labels: ["review"] },
    { title: "Fix review findings", description: "Address any issues found during review.", labels: ["coding"] },
    { title: "Final verification and cleanup", description: "Run full CI, clean up dead code, verify everything.", labels: ["verification"] },
  ],
};

export const BUILTIN_TEMPLATE_NAMES = Object.keys(BUILTIN_TEMPLATES);

/** Template names match in any case, built-in or saved (planTemplates.ts). */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A `planTemplates.list` row. The labels are absent on a server older than them. */
type SavedTemplate = { name: string; description?: string; goal_template?: string; team_id?: string; task_templates: any[]; workspace_label?: string; author?: string; mine?: boolean };

/** "personal", "Acme, by Ann": where a template lives, for telling copies apart. */
const templateWhere = (t: SavedTemplate) => [t.workspace_label, t.author && !t.mine ? `by ${t.author}` : ""].filter(Boolean).join(", ");

/** `--template <name>`: a built-in, else a template saved with `cast plan
 *  template save`. A name saved in several workspaces takes this
 *  workspace's, and within it your own copy; anything still ambiguous is
 *  refused rather than guessed, naming where each copy lives. Unknown names
 *  list what exists. A saved template also carries the goal of the plan it
 *  was saved from. */
export async function planTemplate(deps: GraphDeps, name: string): Promise<{ steps: PlanStep[]; goal?: string }> {
  const builtin = Object.entries(BUILTIN_TEMPLATES).find(([n]) => sameName(n, name))?.[1];
  if (builtin) return { steps: builtin.map((s, i) => ({ ...s, after: i ? [i - 1] : [] })) };
  const saved: SavedTemplate[] = (await deps.cliPost("/cli/plans/templates", {})) ?? [];
  let matches = saved.filter((t) => sameName(t.name, name));
  const copies = () => matches.map(templateWhere).filter(Boolean).join("; ");
  if (matches.length > 1) {
    const here = await deps.workspace();
    const teamId = here.workspace === "team" ? here.team_id : undefined;
    const all = copies();
    matches = matches.filter((t) => (t.team_id ?? undefined) === teamId);
    if (!matches.length) throw new Error(`"${name}" names saved templates in other workspaces${all ? ` (${all})` : ""}, none of them this one; run from a directory of the workspace you mean`);
  }
  if (matches.length > 1 && matches.some((t) => t.mine)) matches = matches.filter((t) => t.mine);
  if (matches.length > 1 && matches.some((t) => t.author)) throw new Error(`"${name}" names templates saved by several people in this workspace (${copies()}); save your own copy under that name to use it`);
  // The list is newest first: an older server without authors gets the newest copy.
  if (matches.length) return { steps: stepsFromTemplate(matches[0]), ...(matches[0].goal_template ? { goal: matches[0].goal_template } : {}) };
  const names = [...BUILTIN_TEMPLATE_NAMES, ...saved.map((t) => `"${t.name}"`)];
  throw new Error(`Unknown template "${name}". Available: ${names.join(", ")}`);
}

/** The session a write names, so the server records an agent's own change
 *  as the agent's and wakes it for nothing (TG2, TG11). */
export function writerOf(deps: Pick<GraphDeps, "sessionId">): { conversation_id?: string } {
  const sessionId = deps.sessionId();
  return sessionId ? { conversation_id: sessionId } : {};
}

/** What every plan step is created with: this checkout, the plan's workspace
 *  and project when known (a directory mapped elsewhere would file the step
 *  outside the plan, and a create inherits no project from its plan), and
 *  the origin the plan itself is stamped with (a person's terminal or
 *  --human files a person's steps, which the board shows). `sessionId` is
 *  the session the plan was stamped with, when its create detected one. */
export function planStepBase(
  deps: GraphDeps,
  opts: { human?: boolean; sessionId?: string | null; plan?: { workspace?: string; team_id?: string; project_id?: string } } = {},
): Record<string, any> {
  const sessionId = opts.sessionId !== undefined ? opts.sessionId : deps.sessionId();
  return {
    project_path: deps.cwd(),
    ...planWorkspace(opts.plan),
    ...(opts.plan?.project_id ? { project_id: opts.plan.project_id } : {}),
    ...workOriginStamp({ sessionId, human: opts.human, stdoutIsTTY: !!process.stdout.isTTY }),
  };
}

/** A plan row's stored access key (`parseWorkspaceKey`) as the workspace a
 *  create names. Only a row with NO key falls back to its routing team, the
 *  way `taskWorkspaceScope` falls back to the directory: a key this CLI cannot
 *  read (a future `restricted:`) names nothing, since reading routing as
 *  access is the bug class the `workspace` field replaced. A row with neither
 *  leaves the route's own default in force.
 *
 *  A `user:` key is sent as the bare `personal`, which the server resolves to
 *  the CALLER (`workspaceScope`), so this says "the caller's own personal
 *  workspace" for whoever the key named. Unlike a task, a plan carries no
 *  per-row grant that would make a teammate's personal one readable here, so
 *  the key is the caller's wherever this is reached. It is a WRITE, and a write
 *  names its workspace rather than leave it to the next resolver, which is why
 *  it does not take `rowWorkspaceScope`'s `{}`: the roster read that would tell
 *  the two apart is async, and every caller of `planStepBase` is not. */
export function planWorkspace(plan: { workspace?: string; team_id?: string } | undefined): { workspace: "team"; team_id: string } | { workspace: "personal" } | {} {
  if (plan?.workspace) {
    const ws = parseWorkspaceKey(plan.workspace);
    return ws ? workspaceScope(ws) : {};
  }
  return plan?.team_id ? { workspace: "team", team_id: plan.team_id } : {};
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerTaskGraphCommands(work: Command, plan: Command, deps: GraphDeps): void {
  work
    .command("supersede")
    .description("Replace a task with another: the old one is dropped with a note, and whatever waited on it now waits on the replacement")
    .argument("<old_id>", "The task being replaced")
    .requiredOption("--with <new_id>", "The task that replaces it")
    .option("--note <text>", "Why, for the old task's history")
    .action(async (oldId: string, options: any) => {
      const result = await deps.cliPost("/cli/work/supersede", { short_id: oldId, by: options.with, ...(options.note ? { note: options.note } : {}), ...writerOf(deps) });
      console.log(`${c.green}ok${c.reset} ${result.short_id} superseded by ${c.cyan}${result.superseded_by}${c.reset}`);
      if (result.moved?.length) console.log(fmt.muted(`  ${result.moved.join(", ")} now wait${result.moved.length === 1 ? "s" : ""} on ${result.superseded_by}`));
    });

  work
    .command("relate")
    .description("Link two tasks as related (see also); it never blocks either")
    .argument("<a>", "Task short ID")
    .argument("<b>", "Task short ID")
    .option("--remove", "Remove the link")
    .action(async (a: string, b: string, options: any) => {
      await deps.cliPost(options.remove ? "/cli/work/unrelate" : "/cli/work/relate", { short_id: a, other: b, ...writerOf(deps) });
      console.log(`${c.green}ok${c.reset} ${a} and ${b} ${options.remove ? "are no longer related" : "are related"}`);
    });

  plan
    .command("steps")
    .description("Append steps to a plan, after its current last wave (its open tasks nothing else in the plan waits on)")
    .argument("<plan_id>", "Plan short ID")
    .argument("<steps>", stdinText(`Steps, ${PLAN_STEPS_GRAMMAR}`))
    .option("--human", "File them as a person's steps (a terminal is detected on its own)")
    .option("--json", "Output the created steps as JSON")
    .action(async (planId: string, text: string, options: any) => {
      let steps: PlanStep[];
      try {
        steps = stepsFromText(text);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const current = await deps.cliPost("/cli/plans/get", { short_id: planId });
      if (!current) {
        console.error(`Plan not found: ${planId}`);
        process.exit(1);
      }
      const roots = planTail<any>(current.tasks ?? []).map((t) => t.short_id as string);
      const say = options.json ? undefined : (line: string) => console.log(line);
      say?.(roots.length ? fmt.muted(`  after ${roots.join(", ")}`) : fmt.muted("  no open steps to follow; the first wave can start now"));
      let created: Awaited<ReturnType<typeof createPlanSteps>>;
      const base = planStepBase(deps, { human: options.human, plan: current });
      try {
        created = await createPlanSteps(deps, current.short_id, steps, { roots, base, say });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      if (options.json) deps.printJson(created);
      else {
        console.log(fmt.muted(`\n  ${created.length} step${created.length === 1 ? "" : "s"} added to ${current.short_id}`));
        console.log(fmt.muted(`  ${planStepsNextAction(current.short_id, teamFlagFor(await deps.namedScope(base)))}`));
      }
    });

  const template = plan
    .command("template")
    .description("Save, list or remove plan templates: a plan's steps and their order, which cast plan create --template <name> writes again");

  template
    .command("save")
    .description("Save a plan's steps and their order as a template")
    .argument("<plan_id>", "Plan short ID")
    .option("--name <name>", "Template name (default: the plan's title); saving the same name again replaces your own template of that name in this workspace")
    .option("-d, --description <text>", "What the template is for")
    .action(async (planId: string, options: any) => {
      const result = await deps.cliPost("/cli/plans/template-save", { plan: planId, ...(options.name ? { name: options.name } : {}), ...(options.description ? { description: options.description } : {}) });
      console.log(`${c.green}ok${c.reset} ${result.replaced ? "Replaced" : "Saved"} template "${result.name}": ${result.steps} steps, ${result.edges} edges`);
      console.log(fmt.muted(`  cast plan create "<title>" --template "${result.name}"`));
    });

  template
    .command("rm")
    .description("Remove a template you saved")
    .argument("<name>", "Template name (any case)")
    .option("--team <name|id|personal>", "The workspace to remove it from, when the name is saved in more than one")
    .action(async (name: string, options: any) => {
      const result = await deps.cliPost("/cli/plans/template-remove", { name, ...(options.team ? await deps.workspace(options.team) : {}) });
      console.log(`${c.green}ok${c.reset} Removed template "${name}"${result.removed > 1 ? ` (${result.removed} copies)` : ""}`);
    });

  template
    .command("ls")
    .alias("list")
    .description("List the plan templates you can use")
    .option("--json", "Output as JSON")
    .action(async (options: any) => {
      const templates = await deps.cliPost("/cli/plans/templates", {});
      if (options.json) return deps.printJson(templates ?? []);
      if (!templates?.length) return console.log(fmt.muted("No saved templates. Save one with cast plan template save <plan>."));
      for (const t of templates as SavedTemplate[]) {
        const where = templateWhere(t);
        console.log(`  ${t.name}  ${fmt.muted(`${where ? `${where} · ` : ""}${t.task_templates.length} steps${t.description ? ` · ${t.description}` : ""}`)}`);
      }
    });
}
