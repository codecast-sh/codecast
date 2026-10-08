"use client";
/**
 * The task page's relations (docs/architecture/task-graph.md TG12), rows of
 * its property grid: one editable Blocked by row listing task blockers and
 * waits together, then Blocks, Found during, Found here and Related. Each
 * line carries its live pill, its state and a remove control; "Add blocker…"
 * opens the palette, which takes a task search or any blocker ref (TG3).
 *
 * Everything reads the store's task rows and writes through store actions
 * (addBlocker, removeBlocker, removeBlocks, removeWait, unrelateTasks), so a change paints
 * at once and the side effect makes the real write.
 */
import { useMemo, type ReactNode } from "react";
import { Check, Clock, GitPullRequest, Hourglass, Plus, Replace, TriangleAlert, X } from "lucide-react";
import { formatWaitTime, isTerminalTaskStatus, type TaskWait } from "@codecast/shared/tasks";
import { relTimeShort } from "@codecast/shared/time";
import { EntityIdPill } from "../EntityIdPill";
import { useInboxStore, type TaskItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useEntityResolution } from "../../lib/entityDisplay";
import { blockerForms, foundHereOf, parseRelationQuery, storeBlockerLines, type BlockerLine, type RelationMode } from "../../lib/taskRelations";
import { undoAsOne } from "../../store/undo/labels";
import { KeyCap } from "../KeyboardShortcutsHelp";

const ROW = "grid grid-cols-[7rem_1fr] items-start px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors";
const LABEL = "text-xs text-sol-text-dim pt-0.5";
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

/** One blocker: its state glyph, pill, a word on where it stands, and remove. */
function Line({ state, children, detail, onRemove, removeLabel }: { state: LineState; children: ReactNode; detail?: ReactNode; onRemove: () => void; removeLabel: string }) {
  const glyph =
    state === "met" ? <Check className="w-3 h-3 text-sol-green" role="img" aria-label="met" />
    : state === "failed" ? <TriangleAlert className="w-3 h-3 text-sol-red" role="img" aria-label="failed" />
    : state === "missing" ? <TriangleAlert className="w-3 h-3 text-sol-text-dim" role="img" aria-label="not found" />
    : <Hourglass className="w-3 h-3 text-sol-orange" role="img" aria-label="waiting" />;
  return (
    <div className={`group/line flex items-center gap-1.5 min-w-0 ${state === "met" ? "opacity-60" : ""}`} data-blocker-state={state}>
      <span className="flex-shrink-0 w-3 flex justify-center">{glyph}</span>
      <span className="min-w-0 flex items-center gap-1.5 flex-wrap text-xs">
        {children}
        {detail}
      </span>
      <RemoveButton label={removeLabel} onClick={onRemove} />
    </div>
  );
}

/** A task blocker. One nothing held answers for, or called missing, is asked
 *  of the server: the store leaves out rows the board never shows. */
function TaskBlockerLine({ line, onRemove }: { line: Extract<BlockerLine, { kind: "task" }>; onRemove: () => void }) {
  if (line.state === "open" || line.state === "met") {
    const closed = line.state === "met";
    return (
      <Line state={closed ? "met" : "waiting"} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}
        detail={closed && line.status ? <span className={DIM}>{line.status}</span> : undefined}>
        <EntityIdPill type="task" shortId={line.ref} />
      </Line>
    );
  }
  return <UnheldTaskBlockerLine line={line} onRemove={onRemove} />;
}

function UnheldTaskBlockerLine({ line, onRemove }: { line: Extract<BlockerLine, { kind: "task" }>; onRemove: () => void }) {
  const { entity, served } = useEntityResolution(line.ref, "task");
  if (entity) {
    const closed = isTerminalTaskStatus(entity.status);
    return (
      <Line state={closed ? "met" : "waiting"} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}>
        <EntityIdPill type="task" shortId={line.ref} />
      </Line>
    );
  }
  return (
    <Line state={served ? "missing" : "waiting"} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}
      detail={served ? <span className={DIM}>not found</span> : undefined}>
      <span className="text-xs font-mono text-sol-text-muted">{line.ref}</span>
    </Line>
  );
}

/** A time wait as a chip: the moment in the viewer's zone, the full date on hover. */
function TimePill({ at, now }: { at: number; now: number }) {
  return (
    <span
      title={formatWaitTime(at, { absolute: true })}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/30 text-[11px] text-sol-text-muted"
    >
      <Clock className="w-3 h-3" />
      {formatWaitTime(at, { now })}
    </span>
  );
}

const WAITING_WORD: Record<TaskWait["kind"], string> = {
  pr_merged: "to merge",
  pr_checks_green: "checks to go green",
  decision: "to be answered",
  time: "",
};
const MET_WORD: Record<TaskWait["kind"], string> = {
  pr_merged: "merged",
  pr_checks_green: "checks green",
  decision: "answered",
  time: "passed",
};

/** A checks wait still waiting on its open PR: red while the checks fail,
 *  which keep it waiting (TG2), so the page says why it is not moving. */
function ChecksWord({ repository, pr_number }: { repository: string; pr_number: number }) {
  const checks = useEntityResolution(`${repository}#${pr_number}`, "pr").entity?.checks_state;
  if (checks === "failure") return <span className="text-xs text-sol-red">checks failing</span>;
  return <span className={DIM}>{checks === "pending" ? "checks running" : WAITING_WORD.pr_checks_green}</span>;
}

function WaitLine({ wait: w, now, onRemove }: { wait: TaskWait; now: number; onRemove: () => void }) {
  const pill =
    w.kind === "time" ? <TimePill at={w.at} now={now} />
    : w.kind === "decision" ? <EntityIdPill type="decision" shortId={w.decision} />
    : w.repository ? <EntityIdPill type="pr" id={`${w.repository}#${w.pr_number}`} certain />
    : (
      <span className="inline-flex items-center gap-1 text-xs font-mono text-sol-text-muted">
        <GitPullRequest className="w-3 h-3" />#{w.pr_number}
      </span>
    );
  const left = w.kind === "time" ? relTimeShort(now, w.at) : "";
  const word =
    w.state === "met" ? w.note || MET_WORD[w.kind]
    : w.state === "failed" ? w.note || "can no longer be met"
    : w.kind === "time" ? (left === "now" ? "any moment" : `in ${left}`)
    : WAITING_WORD[w.kind];
  const detail = w.kind === "pr_checks_green" && w.state === "waiting" && w.repository
    ? <ChecksWord repository={w.repository} pr_number={w.pr_number} />
    : <span className={w.state === "failed" ? "text-xs text-sol-red" : DIM}>{word}</span>;
  return (
    <Line state={w.state} onRemove={onRemove} removeLabel="Remove this wait" detail={detail}>
      {pill}
    </Line>
  );
}

/** Pills for task links, each removable when `onRemove` is given. */
function TaskLinks({ refs, onRemove, removeLabel }: { refs: string[]; onRemove?: (ref: string) => void; removeLabel?: (ref: string) => string }) {
  return (
    <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs">
      {refs.map((ref) => (
        <span key={ref} className="group/line inline-flex items-center gap-0.5 min-w-0">
          <EntityIdPill type="task" shortId={ref} />
          {onRemove && <RemoveButton label={removeLabel?.(ref) ?? `Remove ${ref}`} onClick={() => onRemove(ref)} />}
        </span>
      ))}
    </div>
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

export function TaskRelations({ task, tasks, onAddBlocker }: { task: TaskItem; tasks: Record<string, TaskItem>; onAddBlocker: () => void }) {
  const now = useCoarseNow(60_000);
  const lines = useMemo(() => storeBlockerLines(task, tasks), [task, tasks]);
  const foundHere = useMemo(() => foundHereOf(task, tasks).map((t) => t.short_id), [task, tasks]);
  const store = useInboxStore.getState;
  const id = task.short_id;

  return (
    <>
      <RelationRow label="Blocked by">
        {lines.map((line) =>
          line.kind === "task" ? (
            <TaskBlockerLine key={line.key} line={line} onRemove={() => removeBlocker(id, line)} />
          ) : (
            <WaitLine key={line.key} wait={line.wait} now={now} onRemove={() => store().removeWait(id, line.wait.id)} />
          ),
        )}
        <button onClick={onAddBlocker} className="group/add flex items-center gap-1.5 text-xs text-sol-text-dim hover:text-sol-text text-left transition-colors w-fit">
          {lines.length > 0 && <Plus className="w-3 h-3" />}
          Add blocker…
          <span className="opacity-0 group-hover/add:opacity-100 group-focus-visible/add:opacity-100 transition-opacity"><KeyCap size="xs">b</KeyCap></span>
        </button>
      </RelationRow>
      {!!task.blocks?.length && (
        <RelationRow label="Blocks">
          <TaskLinks refs={task.blocks} onRemove={(ref) => store().removeBlocks(id, ref)} removeLabel={(ref) => `${ref} stops waiting on ${id}`} />
        </RelationRow>
      )}
      {task.found_during && (
        <RelationRow label="Found during">
          <TaskLinks refs={[task.found_during]} />
        </RelationRow>
      )}
      {foundHere.length > 0 && (
        <RelationRow label="Found here">
          <TaskLinks refs={foundHere} />
        </RelationRow>
      )}
      {!!task.related?.length && (
        <RelationRow label="Related">
          <TaskLinks refs={task.related} onRemove={(ref) => store().unrelateTasks(id, ref)} removeLabel={(ref) => `Unlink ${ref}`} />
        </RelationRow>
      )}
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
