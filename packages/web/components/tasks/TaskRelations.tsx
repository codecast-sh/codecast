"use client";
/**
 * The task page's relations (docs/architecture/task-graph.md TG12), rows of
 * its property grid: one editable Blocked by row listing task blockers and
 * waits together, then Blocks, Found during, Found here, Related and Parent. Each
 * line carries its live pill, its state and a remove control; "Add blocker…"
 * opens the palette, which takes a task search or any blocker ref (TG3), and
 * "Link related…" opens it for a see-also task.
 *
 * Everything reads the store's task rows and writes through store actions
 * (addBlocker, removeBlocker, removeBlocks, removeWait, unrelateTasks,
 * setTaskParent), so a change paints
 * at once and the side effect makes the real write.
 */
import { useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Clock, GitPullRequest, Hourglass, Plus, Replace, TriangleAlert, X } from "lucide-react";
import { blockerGatesPickup, FailedWaitIcon } from "./TaskBlockedMark";
import { formatWaitTime, isTerminalTaskStatus, waitFailedWord, WAIT_MET_WORD, WAIT_PENDING_WORD, type TaskWait } from "@codecast/shared/tasks";
import { relTimeShort } from "@codecast/shared/time";
import { EntityIdPill } from "../EntityIdPill";
import { useInboxStore, type TaskItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useEntityResolution } from "../../lib/entityDisplay";
import { blockerForms, foundHereOf, parseRelationQuery, storeBlockerLines, type BlockerLine, type RelationMode } from "../../lib/taskRelations";
import { storeStatusOf } from "../../lib/taskBlockers";
import { lookup } from "../../lib/liveEntities";
import { setTaskParent } from "../../lib/taskActions";
import { undoAsOne } from "../../store/undo/labels";
import { KeyCap } from "../KeyboardShortcutsHelp";

// Every line is one 20px box, the label's included, so the label sits level
// with the first pill and a one-line row keeps the static rows' 28px.
const ROW = "grid grid-cols-[7rem_1fr] items-start px-4 py-1 hover:bg-sol-bg-alt/30 transition-colors";
const LABEL = "h-5 flex items-center text-xs text-sol-text-dim";
const LINE_H = "min-h-5";
const DIM = "text-xs text-sol-text-dim";

function RelationRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={ROW} data-relation={label}>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-col gap-1 min-w-0">{children}</div>
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="p-1.5 -m-1 rounded text-sol-text-dim hover:text-sol-red opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity flex-shrink-0"
    >
      <X className="w-3 h-3" />
    </button>
  );
}

type LineState = "waiting" | "met" | "failed" | "missing";

/** One blocker: its state glyph, pill, a word on where it stands, and remove.
 *  A waiting glyph is orange only while it gates pickup, as the row mark's
 *  is; on a closed task nothing is held, so a waiting line draws dim, as met
 *  ones do. `status` is the task's own. */
function Line({ state, status, children, detail, onRemove, removeLabel }: { state: LineState; status: string; children: ReactNode; detail?: ReactNode; onRemove: () => void; removeLabel: string }) {
  const closed = isTerminalTaskStatus(status);
  const glyph =
    state === "met" ? <Check className="w-3 h-3 text-sol-green" role="img" aria-label="met" />
    : state === "failed" ? <FailedWaitIcon className="w-3 h-3 text-sol-red" role="img" aria-label="failed" />
    : state === "missing" ? <TriangleAlert className="w-3 h-3 text-sol-text-dim" role="img" aria-label="not found" />
    : <Hourglass className={`w-3 h-3 ${blockerGatesPickup(status) ? "text-sol-orange" : "text-sol-text-dim"}`} role="img" aria-label="waiting" />;
  const dim = state === "met" || (closed && state === "waiting");
  return (
    <div className={`group/line flex items-center gap-1.5 min-w-0 ${LINE_H} ${dim ? "opacity-60" : ""}`} data-blocker-state={state}>
      <span className="flex-shrink-0 w-3 flex justify-center">{glyph}</span>
      <span className="min-w-0 flex items-center gap-1.5 text-xs">
        {children}
        {detail && <span className="flex-shrink-0 max-w-[45%] truncate">{detail}</span>}
      </span>
      <RemoveButton label={removeLabel} onClick={onRemove} />
    </div>
  );
}

/** A task blocker. One nothing held answers for, or called missing, is asked
 *  of the server: the store leaves out rows the board never shows. */
type TaskLineProps = { line: Extract<BlockerLine, { kind: "task" }>; status: string; onRemove: () => void };

function TaskBlockerLine({ line, status, onRemove }: TaskLineProps) {
  if (line.state === "open" || line.state === "met") {
    const met = line.state === "met";
    return (
      <Line state={met ? "met" : "waiting"} status={status} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}
        detail={met && line.status ? <span className={DIM}>{line.status}</span> : undefined}>
        <EntityIdPill type="task" shortId={line.ref} wide />
      </Line>
    );
  }
  return <UnheldTaskBlockerLine line={line} status={status} onRemove={onRemove} />;
}

function UnheldTaskBlockerLine({ line, status, onRemove }: TaskLineProps) {
  const { entity, served } = useEntityResolution(line.ref, "task");
  if (entity) {
    return (
      <Line state={isTerminalTaskStatus(entity.status) ? "met" : "waiting"} status={status} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}>
        <EntityIdPill type="task" shortId={line.ref} wide />
      </Line>
    );
  }
  return (
    <Line state={served ? "missing" : "waiting"} status={status} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}
      detail={served ? <span className={DIM}>not found</span> : undefined}>
      <span className="text-xs font-mono text-sol-text-muted">{line.ref}</span>
    </Line>
  );
}

/** A time wait's moment in the viewer's zone, the full date on hover. Inline
 *  like the PR fallback, so the line keeps the pills' height. */
function TimePill({ at, now }: { at: number; now: number }) {
  return (
    <span title={formatWaitTime(at, { absolute: true })} className="inline-flex items-center gap-1 text-xs text-sol-text-muted">
      <Clock className="w-3 h-3" />
      {formatWaitTime(at, { now })}
    </span>
  );
}

/** A checks wait still waiting on its open PR: red while the checks fail,
 *  which keep it waiting (TG2), so the page says why it is not moving. */
function ChecksWord({ repository, pr_number }: { repository: string; pr_number: number }) {
  const checks = useEntityResolution(`${repository}#${pr_number}`, "pr").entity?.checks_state;
  if (checks === "failure") return <span className="text-xs text-sol-red">checks failing</span>;
  return <span className={DIM}>{checks === "pending" ? "checks running" : WAIT_PENDING_WORD.pr_checks_green}</span>;
}

function WaitLine({ wait: w, now, status, onRemove }: { wait: TaskWait; now: number; status: string; onRemove: () => void }) {
  const closed = isTerminalTaskStatus(status);
  const pill =
    w.kind === "time" ? <TimePill at={w.at} now={now} />
    : w.kind === "decision" ? <EntityIdPill type="decision" shortId={w.decision} wide />
    : w.repository ? <EntityIdPill type="pr" id={`${w.repository}#${w.pr_number}`} certain wide />
    : (
      <span className="inline-flex items-center gap-1 text-xs font-mono text-sol-text-muted">
        <GitPullRequest className="w-3 h-3" />#{w.pr_number}
      </span>
    );
  const left = w.kind === "time" ? relTimeShort(now, w.at) : "";
  const word =
    w.state === "met" ? w.note || WAIT_MET_WORD[w.kind]
    : w.state === "failed" ? w.note || waitFailedWord(w.kind)
    : closed ? ""
    : w.kind === "time" ? (left === "now" ? "any moment" : `in ${left}`)
    : WAIT_PENDING_WORD[w.kind];
  const detail = w.kind === "pr_checks_green" && w.state === "waiting" && !closed && w.repository
    ? <ChecksWord repository={w.repository} pr_number={w.pr_number} />
    : word ? <span className={w.state === "failed" ? "text-xs text-sol-red" : DIM}>{word}</span> : undefined;
  return (
    <Line state={w.state} status={status} onRemove={onRemove} removeLabel="Remove this wait" detail={detail}>
      {pill}
    </Line>
  );
}

type IsClosed = (ref: string) => boolean;

/** Pills for task links, a closed one dim like a met blocker, each removable
 *  when `onRemove` is given. */
function TaskLinks({ refs, isClosed, onRemove, removeLabel }: { refs: string[]; isClosed: IsClosed; onRemove?: (ref: string) => void; removeLabel?: (ref: string) => string }) {
  return (
    <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs">
      {refs.map((ref) => (
        <span key={ref} className={`group/line inline-flex items-center gap-0.5 min-w-0 h-5 ${isClosed(ref) ? "opacity-60" : ""}`}>
          <EntityIdPill type="task" shortId={ref} />
          {onRemove && <RemoveButton label={removeLabel?.(ref) ?? `Remove ${ref}`} onClick={() => onRemove(ref)} />}
        </span>
      ))}
    </div>
  );
}

/** The quiet add control closing a row, with its palette key (if it has one) on hover. */
function AddButton({ label, hotkey, plus, onClick }: { label: string; hotkey?: string; plus: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group/add h-5 flex items-center gap-1.5 text-xs text-sol-text-dim hover:text-sol-text text-left transition-colors w-fit">
      {plus && <Plus className="w-3 h-3" />}
      {label}
      {hotkey && <span className="opacity-0 group-hover/add:opacity-100 group-focus-visible/add:opacity-100 transition-opacity"><KeyCap size="xs">{hotkey}</KeyCap></span>}
    </button>
  );
}

/** Remove a task blocker under every form `blocked_by` names it by, as one
 *  undo: a form left behind would bring the line back. */
function removeBlocker(id: string, line: Extract<BlockerLine, { kind: "task" }>) {
  const s = useInboxStore.getState();
  undoAsOne(`Removed blocker ${line.ref} from ${id}`, () => {
    for (const raw of line.raws) s.removeBlocker(id, raw);
  });
}

/** Detach the parent; the store refuses only a task it cannot find. */
function removeParent(id: string) {
  const r = setTaskParent(id, "");
  if (!r.ok) toast.error(r.reason);
}

export function TaskRelations({ task, tasks, onAdd }: { task: TaskItem; tasks: Record<string, TaskItem>; onAdd: (mode: RelationMode | "parent") => void }) {
  const now = useCoarseNow(60_000);
  const lines = useMemo(() => storeBlockerLines(task, tasks), [task, tasks]);
  const foundHere = useMemo(() => foundHereOf(task, tasks).map((t) => t.short_id), [task, tasks]);
  const isClosed = useMemo<IsClosed>(() => {
    const statusOf = storeStatusOf(tasks, task);
    return (ref) => {
      const found = statusOf(ref);
      return isTerminalTaskStatus(found?.status);
    };
  }, [task, tasks]);
  // `parent_id` holds the parent's _id; its pill reads best by short id.
  const parentId = task.parent_id ? String(task.parent_id) : null;
  const parent = parentId ? (lookup(tasks, parentId)?.short_id ?? parentId) : null;
  const store = useInboxStore.getState;
  const id = task.short_id;

  return (
    <>
      <RelationRow label="Blocked by">
        {lines.map((line) =>
          line.kind === "task" ? (
            <TaskBlockerLine key={line.key} line={line} status={task.status} onRemove={() => removeBlocker(id, line)} />
          ) : (
            <WaitLine key={line.key} wait={line.wait} now={now} status={task.status} onRemove={() => store().removeWait(id, line.wait.id)} />
          ),
        )}
        <AddButton label="Add blocker…" hotkey="b" plus={lines.length > 0} onClick={() => onAdd("blocker")} />
      </RelationRow>
      {!!task.blocks?.length && (
        <RelationRow label="Blocks">
          <TaskLinks refs={task.blocks} isClosed={isClosed} onRemove={(ref) => store().removeBlocks(id, ref)} removeLabel={(ref) => `${ref} stops waiting on ${id}`} />
        </RelationRow>
      )}
      {task.found_during && (
        <RelationRow label="Found during">
          <TaskLinks refs={[task.found_during]} isClosed={isClosed} />
        </RelationRow>
      )}
      {foundHere.length > 0 && (
        <RelationRow label="Found here">
          <TaskLinks refs={foundHere} isClosed={isClosed} />
        </RelationRow>
      )}
      <RelationRow label="Related">
        {!!task.related?.length && <TaskLinks refs={task.related} isClosed={isClosed} onRemove={(ref) => store().unrelateTasks(id, ref)} removeLabel={(ref) => `Unlink ${ref}`} />}
        <AddButton label="Link related…" plus={!!task.related?.length} onClick={() => onAdd("related")} />
      </RelationRow>
      <RelationRow label="Parent">
        {parent ? (
          <TaskLinks refs={[parent]} isClosed={isClosed} onRemove={() => removeParent(id)} removeLabel={() => "Remove parent"} />
        ) : (
          <AddButton label="Set parent…" plus={false} onClick={() => onAdd("parent")} />
        )}
      </RelationRow>
    </>
  );
}

/** A replaced task says so at the top of its page, and links the replacement (TG5). */
export function SupersededBanner({ task }: { task: Pick<TaskItem, "superseded_by"> }) {
  if (!task.superseded_by) return null;
  return (
    <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md border border-sol-border/30 bg-sol-bg-alt/40 text-xs text-sol-text-muted" data-superseded>
      <Replace className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
      <span>Superseded by</span>
      <EntityIdPill type="task" shortId={task.superseded_by} />
    </div>
  );
}

/** Under the palette's field: the refs it reads (TG3), or, once the query
 *  matches no task and reads as no ref, why. */
export function RelationQueryHint({ mode, search, matched, targets }: { mode: RelationMode; search: string; matched: boolean; targets: TaskItem[] }) {
  const parsed = parseRelationQuery(search, mode);
  const error = !matched && parsed && "error" in parsed ? parsed.error : null;
  return (
    <div className="px-4 py-1.5 border-b border-sol-border/30 text-[10px] text-sol-text-dim" data-relation-hint>
      {error ? (
        <span className="text-sol-red">{error}</span>
      ) : mode === "blocker" ? (
        <span className="flex items-center gap-1 flex-wrap">
          Search a task, or paste
          {blockerForms(targets).map((f, i) => (
            <span key={f} className="inline-flex items-center gap-1">
              {i > 0 && <span aria-hidden>·</span>}
              <code className="font-mono text-sol-text-muted">{f}</code>
            </span>
          ))}
          then <KeyCap size="xs">↵</KeyCap>
        </span>
      ) : (
        <span className="flex items-center gap-1">Search a task, or paste <code className="font-mono text-sol-text-muted">ct-12</code>, then <KeyCap size="xs">↵</KeyCap></span>
      )}
    </div>
  );
}
