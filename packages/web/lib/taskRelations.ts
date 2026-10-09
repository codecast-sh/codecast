// The task page's relations (docs/architecture/task-graph.md TG12): what the
// Blocked by row lists, what the add-blocker and related palettes offer, and
// what a pick writes. Read from the store; written through the store actions
// addBlocker/addWait/relateTasks, whose side effects make the real write.
import {
  dependencyLoopChecker,
  GRAPH_LINK_CAP,
  isActiveTask,
  isCleared,
  isTerminalTaskStatus,
  isPrWaitTarget,
  newWaitId,
  parseBlockerRef,
  prRef,
  taskBlockerEntries,
  UNKNOWN_BLOCKER_STATUS,
  waitClause,
  waitIsReplaceable,
  waitTargetOf,
  type WaitLabelOptions,
  type GraphTask,
  type StatusOf,
  type TaskWait,
  type WaitTarget,
} from "@codecast/shared/tasks";
import { localTimeZone } from "@codecast/shared/time";
import { toast } from "sonner";
import { useInboxStore, type TaskItem } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { waitIsOn } from "../store/taskGraphDraft";
import { counted, undoAsOne } from "../store/undo/labels";
import { lookup } from "./liveEntities";
import { setTaskParent } from "./taskActions";
import { storeStatusOf, type BoardTask } from "./taskBlockers";
import { filterByWorkspace, workspaceKeyOfRow } from "./workspaceScope";

// ---------------------------------------------------------------------------
// The Blocked by row
// ---------------------------------------------------------------------------

/**
 * One line of the Blocked by row. A task blocker is `open` while it holds the
 * task, `met` once it closed, `missing` when its id was looked up and names no
 * task, `unknown` when nothing the client holds answers for it (the row asks
 * the server). `raws` are the forms `blocked_by` stores it under, all of which
 * removal names. A wait carries its own state; a met one stays listed until removed.
 */
export type BlockerLine =
  | { key: string; kind: "task"; ref: string; raws: string[]; state: "open" | "met" | "missing" | "unknown"; status?: string }
  | { key: string; kind: "wait"; wait: TaskWait };

/** Every blocker of `task`, task blockers in `blocked_by` order then waits:
 *  the shared entries readiness filters, so this row and readiness agree. */
export function blockerLines(task: GraphTask, statusOf: StatusOf): BlockerLine[] {
  const lines: BlockerLine[] = taskBlockerEntries(task, statusOf).map(({ blocker: b, raws }) => {
    const state = "missing" in b ? "missing" : isCleared(b) ? "met" : b.status === UNKNOWN_BLOCKER_STATUS ? "unknown" : "open";
    const status = "status" in b && b.status !== UNKNOWN_BLOCKER_STATUS ? b.status : undefined;
    return { key: `task:${b.ref}`, kind: "task", ref: b.ref, raws, state, ...(status ? { status } : {}) };
  });
  for (const w of task.waits ?? []) lines.push({ key: `wait:${w.id}`, kind: "wait", wait: w });
  return lines;
}

/** The store's tasks that were found while working on `task` (TG5), in its
 *  workspace, oldest first and stopped at the shared cap, so the page and
 *  `cast task show` list the same tasks (convex foundHereRows). */
export function foundHereOf(task: Pick<TaskItem, "short_id" | "workspace" | "team_id">, tasks: Record<string, TaskItem>): TaskItem[] {
  return sameWorkspace(tasks, task)
    .filter((t) => t.found_during === task.short_id)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, GRAPH_LINK_CAP);
}

/** `task`'s `blocks` mirror as every surface prints it (convex taskLinksOf):
 *  stopped at the shared cap, and without an entry the client can see has
 *  gone stale — a dependent whose row it holds and whose `blocked_by` no
 *  longer names this task. An entry whose row the store lacks stays, so an
 *  unloaded dependent is never hidden. */
export function blocksOf(task: TaskItem, tasks: Record<string, TaskItem>): string[] {
  const self = new Set([task.short_id, String(task._id)]);
  const home = workspaceKeyOfRow(task);
  // Capped before the stale ones are dropped, exactly as the server reads it,
  // so both name the same tasks on a row that got past the cap.
  return (task.blocks ?? [])
    .slice(0, GRAPH_LINK_CAP)
    .filter((ref) => {
      const row = lookup(tasks, ref);
      // Only a live row in this task's workspace can answer: the server reads
      // the mirror no further either (taskLinksOf's readableLink).
      if (!row || workspaceKeyOfRow(row) !== home) return true;
      return ((row.blocked_by ?? []) as string[]).some((r) => self.has(r));
    });
}

/** `task`'s see-also links at the same cap, so the page and `cast task show`
 *  list the same tasks even on a row that got past the write-time cap. */
export function relatedOf(task: TaskItem): string[] {
  return (task.related ?? []).slice(0, GRAPH_LINK_CAP);
}

/** The store's tasks in `task`'s own workspace: what its relations may name. */
function sameWorkspace(tasks: Record<string, TaskItem>, task: Pick<TaskItem, "workspace" | "team_id">): TaskItem[] {
  return filterByWorkspace(Object.values(tasks), workspaceKeyOfRow(task));
}

/** Whether `task` has a wait on `target` that `is` matches. One that stands
 *  (still waiting, or met for good): the server would return it and write
 *  nothing, so a second one is never painted. A replaceable one
 *  (waitIsReplaceable): the new wait takes its place (addWaitDraft). */
function hasWaitOn(task: Pick<TaskItem, "waits">, target: WaitTarget, is: (w: TaskWait) => boolean): boolean {
  return (task.waits ?? []).some((w) => is(w) && waitIsOn(w, target));
}
const isWaiting = (w: TaskWait) => w.state === "waiting";
const stands = (w: TaskWait) => !waitIsReplaceable(w);

// ---------------------------------------------------------------------------
// The palette (modes "blocker", "blocks" and "related")
// ---------------------------------------------------------------------------

/** Which link the palette writes: a blocker of the target ("blocker"), a task
 *  that waits on the target ("blocks", the Blocks row's own add, which writes
 *  the same edge from the other side), a see-also link, or the task this one
 *  was found while working on ("found_during", a provenance link the server
 *  GUESSES from the filing session's bound task and so needs repointing, TG5). */
export type RelationMode = "blocker" | "related" | "blocks" | "found_during";

/** The modes that edit the one dependency edge, in either direction. */
const isDepMode = (mode: RelationMode) => mode === "blocker" || mode === "blocks";

/** Whether a palette mode is one of the relation searches, for the palette's
 *  branches: one list, so a mode added here reaches every one of them. */
export function isRelationMode(mode: string | null | undefined): mode is RelationMode {
  return mode === "blocker" || mode === "blocks" || mode === "related" || mode === "found_during";
}

/** A palette row: a task to link, or (blocker) a wait parsed from the query.
 *  A task row carries what its line draws (`task`); `warn` marks a hint that
 *  says the pick will be refused. */
export type RelationItem = {
  key: string;
  label: string;
  hint?: string;
  warn?: boolean;
  task?: RelationTask;
  pick: { kind: "task"; ref: string } | { kind: "wait"; target: WaitTarget };
};

/** A task as a palette line draws it: its id, title and status glyph. */
export type RelationTask = { ref: string; title?: string; status?: string };

/** The task links a mode edits on `t`. `found_during` holds one task, so it
 *  reads as a list of nought or one and a pick on another task repoints it. */
const linksOf = (t: TaskItem, mode: RelationMode): string[] =>
  mode === "found_during"
    ? (t.found_during ? [t.found_during] : [])
    : (mode === "blocker" ? t.blocked_by : mode === "blocks" ? t.blocks : t.related) ?? [];

/** Where a row sits: list rows carry their plan and project ids untyped. */
type Placed = { plan_id?: string; project_id?: string; project_path?: string };
const projectOf = (t: TaskItem) => (t as Placed).project_id || t.project_path;

/** The server finds a bare `#42` through the task's project (TG3). */
const hasProject = (t: TaskItem) => !!projectOf(t);

/** How near `t` sits to `target`: its plan's siblings first (the likeliest
 *  blocker), then its project's, then everything else. */
function nearness(t: TaskItem, target: TaskItem): number {
  const plan = (t as Placed).plan_id;
  if (plan && plan === (target as Placed).plan_id) return 0;
  const project = projectOf(t);
  return project && project === projectOf(target) ? 1 : 2;
}

/** A wait's clause, its PR named in full once the repository is known, so
 *  the palette row, the toast and the remove button word one wait the same way. */
export const clauseOf = (target: WaitTarget, opts: WaitLabelOptions = {}) =>
  waitClause(target, { ...opts, fullRef: "repository" in target && !!target.repository });

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The forms the add-blocker field reads (TG3), shown under it. A bare `#42`
 *  only when every target has a project to find it in; the date a few days
 *  ahead in the viewer's zone, so a copied example is never already past. */
export function blockerForms(targets: TaskItem[], now = Date.now()): string[] {
  const d = new Date(now + 3 * 86_400_000);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 09:00`;
  const pr = targets.length > 0 && targets.every(hasProject) ? "#42" : "owner/repo#42";
  return ["ct-12", pr, `${pr}:checks`, "sd-4", "2h", date];
}

/** The query read as a ref: what to offer first, or why it reads as none.
 *  An error is only an error once no task title matches either.
 *  `unrecognized`: the query has no ref's shape at all, so the hint lists the
 *  forms rather than the error. A ref of the WRONG KIND for the mode (a PR
 *  pasted into "Link related task…") is recognized: it parsed, so the hint says
 *  which kind the mode takes, and its sentence already names the form. */
export function parseRelationQuery(search: string, mode: RelationMode, now = Date.now(), timeZone = localTimeZone()):
  { pick: RelationItem["pick"] } | { error: string; unrecognized?: true } | null {
  const text = search.trim();
  if (!text) return null;
  const ref = parseBlockerRef(text, { now, timeZone });
  if (!ref.ok) return ref.unrecognized ? { error: ref.error, unrecognized: true } : { error: ref.error };
  if (ref.kind === "task") return { pick: { kind: "task", ref: ref.ref } };
  if (mode === "blocks") return { error: `A task that waits on this one is a task (ct-12), not ${text}` };
  if (mode === "related") return { error: `A related link is to a task (ct-12), not ${text}` };
  if (mode === "found_during") return { error: `A task is found while working on a task (ct-12), not ${text}` };
  return { pick: { kind: "wait", target: waitTargetOf(ref) } };
}

/** Why the palette's query is no relation: set once it matches no task and
 *  reads as no ref. The hint shows it, in place of the list's "No results". */
export function relationQueryError(search: string, mode: RelationMode, matched: boolean) {
  const parsed = matched ? null : parseRelationQuery(search, mode);
  return parsed && "error" in parsed ? parsed : null;
}

/** Detach the parent; the store refuses only a task it cannot find. The task
 *  page's breadcrumb is where a subtask states its parent, so it carries this. */
export function removeTaskParent(id: string): void {
  const r = setTaskParent(id, "");
  if (!r.ok) toast.error(r.reason);
}

/** A relations line's state glyph as words. The bare state value ("met") has
 *  no subject, and a met blocker's line carries no other text, so a reader
 *  hearing it would not learn WHAT is met. `subject` is what the line is
 *  about, in the same vocabulary as the CLI's ("blocker", "wait"). */
export function lineStateLabel(state: "waiting" | "met" | "failed", subject: "blocker" | "wait"): string {
  if (state === "met") return `${subject} met`;
  if (state === "failed") return `${subject} failed, needs a re-plan`;
  return `still waiting on this ${subject}`;
}

/**
 * Why one task cannot wait on another, over the edges the server counts:
 * `owner` names the workspace to read (done and dropped tasks left out, TG4)
 * and the pair is the edge, whichever way round the palette writes it. One
 * index per workspace, built on first use, so marking every candidate reads
 * the collection once.
 */
function loopChecker(tasks: Record<string, TaskItem>): (owner: TaskItem, task: string, blocker: string) => string | null {
  const byWorkspace = new Map<string | null, (task: string, blocker: string) => string | null>();
  return (owner, task, blocker) => {
    const key = workspaceKeyOfRow(owner);
    let check = byWorkspace.get(key);
    if (!check) byWorkspace.set(key, (check = dependencyLoopChecker(sameWorkspace(tasks, owner).filter((t) => !isTerminalTaskStatus(t.status)))));
    return check(task, blocker);
  };
}

/** The edge a pick writes, as the loop checker reads it: which task would
 *  wait, and on what. "blocks" is the same edge from the other side, so the
 *  check is the same one, with its ends swapped. */
const depEdge = (mode: RelationMode, target: TaskItem, ref: string): [task: string, blocker: string] =>
  mode === "blocks" ? [ref, target.short_id] : [target.short_id, ref];

/** Whether the link a pick would write is already on `target`. For "blocks"
 *  both rows are read: the dependent's own `blocked_by` is the authority for
 *  the edge (by either form it may name the task under), and the mirror alone
 *  can lag it, so a pick on a task that already waits is never offered as new. */
function alreadyLinked(mode: RelationMode, target: TaskItem, ref: string, row: TaskItem | undefined): boolean {
  if (mode !== "blocks") return linksOf(target, mode).includes(ref);
  const forms = [target.short_id, String(target._id)];
  return (target.blocks ?? []).includes(ref) || ((row?.blocked_by ?? []) as string[]).some((r) => forms.includes(r));
}

/** The palette rows for `targets`: the parsed ref first, then open, active
 *  tasks (the board's, so no mined suggestions) of the same workspace
 *  matching the query, nearest the first target first, without what is
 *  already linked. */
export function relationItems(
  mode: RelationMode,
  search: string,
  targets: TaskItem[],
  tasks: Record<string, TaskItem>,
  now = Date.now(),
  timeZone = localTimeZone(),
): RelationItem[] {
  const target = targets[0];
  if (!target) return [];
  const selves = new Set(targets.map((t) => t.short_id));
  const rows = sameWorkspace(tasks, target);
  const byShort = new Map(rows.map((t) => [t.short_id, t]));
  // What a pick would not change, on any target (the loose list) or on all of
  // them (the pasted ref's hint).
  const linkedAny = (ref: string, row?: TaskItem) => targets.some((t) => alreadyLinked(mode, t, ref, row));
  const loops = loopChecker(tasks);
  const q = search.trim().toLowerCase();
  const out: RelationItem[] = [];
  const parsed = parseRelationQuery(search, mode, now, timeZone);
  if (parsed && "pick" in parsed) {
    if (parsed.pick.kind === "wait") {
      const wait = parsed.pick.target;
      const on = clauseOf(wait, { now, timeZone });
      const has = (is: (w: TaskWait) => boolean) => (t: TaskItem) => hasWaitOn(t, wait, is);
      const hint = targets.every(has(isWaiting)) ? "already waiting"
        : targets.every(has(stands)) ? "already set"
        : targets.some(has((w) => w.state === "failed")) ? "replaces the failed wait" : undefined;
      out.push({ key: `wait:${search.trim()}`, label: `Wait ${on}`, ...(hint ? { hint } : {}), pick: parsed.pick });
    } else {
      // A pasted ref that is already linked is still listed, saying why a pick would change nothing.
      const ref = parsed.pick.ref;
      const self = targets.some((t) => t.short_id === ref);
      const already = targets.every((t) => alreadyLinked(mode, t, ref, byShort.get(ref)));
      const item = taskItem(mode, ref, byShort.get(ref), targets, loops);
      const alreadyWords = mode === "blocker" ? "already a blocker" : mode === "blocks" ? "already waiting on this" : "already linked";
      const hint = self ? "this task" : already ? alreadyWords : item.hint;
      out.push({ ...item, ...(hint ? { hint } : {}) });
    }
  }
  const loose = rows
    .filter((t) =>
      !selves.has(t.short_id) &&
      !linkedAny(t.short_id, t) &&
      !out.some((i) => i.pick.kind === "task" && i.pick.ref === t.short_id) &&
      !isTerminalTaskStatus(t.status) &&
      isActiveTask(t) &&
      !String(t._id).startsWith("temp_") &&
      (q === "" || t.title?.toLowerCase().includes(q) || t.short_id.toLowerCase().includes(q)))
    .sort((a, b) => nearness(a, target) - nearness(b, target) || b.updated_at - a.updated_at)
    .slice(0, 8);
  for (const t of loose) out.push(taskItem(mode, t.short_id, t, targets, loops));
  return out;
}

function taskItem(mode: RelationMode, ref: string, row: TaskItem | undefined, targets: TaskItem[], loops: ReturnType<typeof loopChecker>): RelationItem {
  const loop = isDepMode(mode) && targets.some((t) => t.short_id !== ref && loops(t, ...depEdge(mode, t, ref)));
  return {
    key: `task:${ref}`,
    label: row?.title ? `${ref}  ${row.title}` : ref,
    task: { ref, title: row?.title, status: row?.status },
    // A ref the store does not hold may name no task, or one in another
    // workspace: only the server can say, so the row does not pass for a known one.
    ...(loop ? { hint: "would close a loop", warn: true } : row ? {} : { hint: "not loaded: the server will check it" }),
    pick: { kind: "task", ref },
  };
}

/** What a pick did. `landed` settles once the server has every write: it
 *  resolves to what to say then, and rejects with the dispatch error (a
 *  refusal is rolled back and reported by lib/dispatchBinding). `pending`:
 *  the server has yet to check the target (a PR it may not see, a bare `#42`
 *  it may not place), so `message` says it is checking, and `parked` is what
 *  to say if the write waits in the outbox instead. */
export type RelationPickResult =
  | { ok: false; message: string }
  | { ok: true; message: string; pending?: true; parked?: string; landed: Promise<string> };

/**
 * Write a palette pick onto every target that lacks it, as one undo. A task
 * blocker that would close a loop is refused here with the server's own words
 * (dependencyLoopChecker), so nothing paints that the echo would take back.
 */
export function applyRelationPick(mode: RelationMode, targets: TaskItem[], pick: RelationItem["pick"]): RelationPickResult {
  const s = useInboxStore.getState();
  const nameOf = (ts: TaskItem[]) => (ts.length === 1 ? ts[0]!.short_id : `${ts.length} tasks`);
  const waits = (ts: TaskItem[]) => (ts.length === 1 ? "waits" : "wait");
  const names = nameOf(targets);
  const sent = (message: string, writes: Promise<unknown>[]) => ({ ok: true as const, message, landed: Promise.all(writes).then(() => message) });
  if (pick.kind === "wait") {
    const on = clauseOf(pick.target);
    const fresh = targets.filter((t) => !hasWaitOn(t, pick.target, stands));
    if (!fresh.length) {
      const waiting = targets.every((t) => hasWaitOn(t, pick.target, isWaiting));
      return { ok: false, message: waiting ? `${names} already ${waits(targets)} ${on}` : `${names} already ${targets.length === 1 ? "has" : "have"} a wait ${on}` };
    }
    const writes = undoAsOne(`Made ${counted(fresh.length, "task")} wait ${on}`, () =>
      fresh.map((t) => s.addWait(t.short_id, { id: newWaitId(), target: pick.target })));
    const done = `${nameOf(fresh)} ${waits(fresh)} ${on}`;
    // The server may meet the wait at once (a PR already merged or green, a
    // decision already answered): its note says so.
    const landed = Promise.all(writes).then((results) => {
      const notes = results.map((r: any) => (r?.met ? r.wait?.note : undefined));
      return notes.every(Boolean) ? `${done}: ${notes[0]}` : done;
    });
    if (!isPrWaitTarget(pick.target)) return { ok: true, message: done, landed };
    const parked = `${nameOf(fresh)} will wait ${on} once it reaches the server`;
    return { ok: true, pending: true, message: `Checking PR ${prRef(pick.target, { fullRef: true })} for ${nameOf(fresh)}…`, parked, landed };
  }
  const selfVerb = mode === "related" ? "relate to" : mode === "found_during" ? "be found during" : "wait on";
  if (targets.some((t) => t.short_id === pick.ref)) return { ok: false, message: `A task can't ${selfVerb} itself` };
  const row = lookup(s.tasks as Record<string, TaskItem>, pick.ref);
  const fresh = targets.filter((t) => !alreadyLinked(mode, t, pick.ref, row));
  if (!fresh.length) {
    return {
      ok: false,
      message: mode === "blocker" ? `${names} already ${waits(targets)} on ${pick.ref}`
        : mode === "blocks" ? `${pick.ref} already waits on ${names}`
        : mode === "found_during" ? `${names} already found during ${pick.ref}`
        : `${names} already linked to ${pick.ref}`,
    };
  }
  // One task per row, so a pick on a task the row does not already name
  // REPLACES the link the create guessed rather than adding to it.
  if (mode === "found_during") {
    const writes = undoAsOne(`Found ${counted(fresh.length, "task")} during ${pick.ref}`, () =>
      fresh.map((t) => s.updateTask(t.short_id, { found_during: pick.ref })));
    return sent(`${nameOf(fresh)} found during ${pick.ref}`, writes);
  }
  if (mode === "related") {
    const writes = undoAsOne(`Linked ${counted(fresh.length, "task")} to ${pick.ref}`, () => fresh.map((t) => s.relateTasks(t.short_id, pick.ref)));
    return sent(`Linked ${nameOf(fresh)} and ${pick.ref}`, writes);
  }
  const loops = loopChecker(s.tasks as Record<string, TaskItem>);
  for (const t of fresh) {
    const loop = loops(t, ...depEdge(mode, t, pick.ref));
    if (loop) return { ok: false, message: loop };
  }
  // "blocks" writes the one edge from the other side: the picked task waits on
  // this one, so addBlocker is called with its ends swapped.
  if (mode === "blocks") {
    const writes = undoAsOne(`Made ${pick.ref} wait on ${counted(fresh.length, "task")}`, () => fresh.map((t) => s.addBlocker(pick.ref, t.short_id)));
    return sent(`${pick.ref} waits on ${nameOf(fresh)}`, writes);
  }
  const writes = undoAsOne(`Made ${counted(fresh.length, "task")} wait on ${pick.ref}`, () => fresh.map((t) => s.addBlocker(t.short_id, pick.ref)));
  return sent(`${nameOf(fresh)} ${waits(fresh)} on ${pick.ref}`, writes);
}

/** Tell the person what a pick did. A check still running shows as loading
 *  and turns into what landed, as does a pick the server says more about (a
 *  wait met at once). A refusal clears this toast: the dispatch failure toast
 *  gives the server's reason, once, whoever made the write. */
export function reportRelationPick(res: RelationPickResult): void {
  if (!res.ok) {
    toast.error(res.message);
    return;
  }
  const id = res.pending ? toast.loading(res.message) : toast.success(res.message);
  res.landed.then(
    (done) => { if (res.pending || done !== res.message) toast.success(done, { id }); },
    // Parked for the outbox: still on its way, so the check becomes a plain note.
    (error) => (isRefusedDispatchError(error) ? toast.dismiss(id) : res.parked && toast(res.parked, { id })),
  );
}

/** The Blocked by row's lines for a task, read from the store. */
export function storeBlockerLines(task: BoardTask, tasks: Record<string, any>): BlockerLine[] {
  return blockerLines(task, storeStatusOf(tasks, task));
}
