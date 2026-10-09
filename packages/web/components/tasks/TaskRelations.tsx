"use client";
/**
 * The task page's relations (docs/architecture/task-graph.md TG12), rows of
 * its property grid: one editable Blocked by row listing task blockers and
 * waits together, then Blocks, Found during, Found here and Related, each
 * shown once it has something in it. Each line carries its live pill, its
 * state and a remove control; "Add blocker…" opens the palette, which takes a
 * task search or any blocker ref (TG3), and one last line offers whichever of
 * "Link related…" and "Set parent…" the task has no answer for yet. The parent
 * is stated once, by the page's breadcrumb, which carries its own remove.
 *
 * Everything reads the store's task rows and writes through store actions
 * (addBlocker, removeBlocker, removeBlocks, removeWait, unrelateTasks), so a
 * change paints at once and the side effect makes the real write.
 */
import { useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { CircleDashed, Clock, GitPullRequest, Plus, Replace, X } from "lucide-react";
import { waitStateStyle } from "./TaskBlockedMark";
import { BLOCKER_NOT_FOUND_WORDS, BLOCKER_UNKNOWN_WORDS, checksWaitPr, formatWaitTime, isTerminalTaskStatus, isUnblocked, waitStateWord, waitWordFails, type TaskWait } from "@codecast/shared/tasks";
import { EntityIdPill } from "../EntityIdPill";
import { useInboxStore, type TaskItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useEntityResolution } from "../../lib/entityDisplay";
import { blockerForms, blocksOf, clauseOf, foundHereOf, parseRelationQuery, relatedOf, storeBlockerLines, type BlockerLine, type RelationMode } from "../../lib/taskRelations";
import { storeStatusOf } from "../../lib/taskBlockers";
import { workspaceKeyOfRow } from "../../lib/workspaceScope";
import { setTaskParent } from "../../lib/taskActions";
import { undoAsOne } from "../../store/undo/labels";
import { withoutUndo } from "../../store/undoStack";
import { KeyCap } from "../KeyboardShortcutsHelp";

// Every line is one 20px box, the label's included, so the label sits level
// with the first pill and a one-line row keeps the static rows' 28px.
const ROW = "grid grid-cols-[7rem_1fr] items-start px-4 py-1 hover:bg-sol-bg-alt/30 transition-colors";
const LABEL = "h-5 flex items-center text-xs text-sol-text-dim";
const LINE_H = "min-h-5";
const DIM = "text-xs text-sol-text-dim";
/** The gutter a line's state glyph sits in, kept by lines that have none. */
const GLYPH = "flex-shrink-0 w-3 flex justify-center";

function RelationRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={ROW} data-relation={label || "add"}>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-col gap-1 min-w-0">{children}</div>
    </div>
  );
}

/** A line's remove control: quiet until the line is hovered or focused, and
 *  focusable with the same ring as the row's other buttons. `offer` is for a
 *  line whose only purpose is to be cleaned up (a blocker that names no task):
 *  it stays at full strength and says the word, since a hidden X would hide
 *  the one action the line affords. */
export function RemoveButton({ label, onClick, offer }: { label: string; onClick: () => void; offer?: boolean }) {
  const quiet = "opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60";
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`rounded text-sol-text-dim hover:text-sol-red focus-visible:text-sol-red transition-opacity flex-shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan focus-visible:outline-offset-2 ${offer ? "px-1 -mx-0.5 text-xs" : `p-1.5 -m-1 ${quiet}`}`}
    >
      {offer ? "Remove" : <X className="w-3 h-3" />}
    </button>
  );
}

type LineState = "waiting" | "met" | "failed" | "missing";

/** One blocker: its state glyph, pill, a word on where it stands, and remove.
 *  Unlike the row mark, an open blocker keeps its colour while the task is
 *  being worked, because this page is where a person asks why it is not
 *  moving; only on a closed task, which nothing holds, does a waiting or
 *  failed line draw dim, as met ones do. `status` is the task's own. */
function Line({ state, status, children, detail, onRemove, removeLabel }: { state: LineState; status: string; children: ReactNode; detail?: ReactNode; onRemove: () => void; removeLabel: string }) {
  const style = state === "missing" ? null : waitStateStyle(state, status, { untilClosed: true });
  const glyph = style
    ? <style.icon className={`w-3 h-3 ${style.text}`} role="img" aria-label={state} />
    : <CircleDashed className="w-3 h-3 text-sol-text-dim" role="img" aria-label={BLOCKER_NOT_FOUND_WORDS} />;
  // One dimming rule: the tone `waitStateStyle` already decided (dim once the
  // line holds nothing), plus a met line, which keeps its green glyph.
  const dim = state === "met" || style?.tone === "dim";
  return (
    <div className={`group/line flex items-center gap-1.5 min-w-0 ${LINE_H} ${dim ? "opacity-60" : ""}`} data-blocker-state={state}>
      <span className={GLYPH}>{glyph}</span>
      <span className="min-w-0 flex items-center gap-1.5 text-xs">
        {children}
        {detail && <span className="flex-shrink-0 max-w-[45%] truncate">{detail}</span>}
      </span>
      <RemoveButton label={removeLabel} onClick={onRemove} offer={state === "missing"} />
    </div>
  );
}

/** A task blocker. One nothing held answers for, or called missing, is asked
 *  of the server: the store leaves out rows the board never shows. A row in
 *  another workspace is no answer (readiness never reads across), so its
 *  status stays unknown, as the row mark and the CLI say. */
type TaskLineProps = { line: Extract<BlockerLine, { kind: "task" }>; task: TaskItem; onRemove: () => void };

function TaskBlockerLine({ line, task, onRemove }: TaskLineProps) {
  if (line.state === "open" || line.state === "met") return <HeldTaskLine line={line} met={line.state === "met"} task={task} onRemove={onRemove} />;
  return <UnheldTaskBlockerLine line={line} task={task} onRemove={onRemove} />;
}

/** A task blocker whose status is known: its pill, met once it closed. */
function HeldTaskLine({ line, met, task, onRemove }: TaskLineProps & { met: boolean }) {
  return (
    <Line state={met ? "met" : "waiting"} status={task.status} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}>
      <EntityIdPill type="task" shortId={line.ref} wide />
    </Line>
  );
}

function UnheldTaskBlockerLine({ line, task, onRemove }: TaskLineProps) {
  const { entity, served } = useEntityResolution(line.ref, "task");
  if (entity && workspaceKeyOfRow(entity) === workspaceKeyOfRow(task)) {
    return <HeldTaskLine line={line} met={isTerminalTaskStatus(entity.status)} task={task} onRemove={onRemove} />;
  }
  const missing = served && !entity;
  const word = entity ? BLOCKER_UNKNOWN_WORDS : missing ? BLOCKER_NOT_FOUND_WORDS : undefined;
  return (
    <Line state={missing ? "missing" : "waiting"} status={task.status} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}
      detail={word ? <span title={word} className={DIM}>{word}</span> : undefined}>
      <span className="text-xs font-mono text-sol-text-muted">{line.ref}</span>
    </Line>
  );
}

/** A pill for what has no entity of its own (a time, a PR codecast cannot
 *  place yet), in EntityIdPill's chrome so the column stays even. */
function PlainPill({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <span title={title} className="inline-flex items-center gap-[0.2em] px-[0.2em] rounded-[0.2em] leading-none font-medium bg-sol-bg-alt text-sol-text-muted">
      {children}
    </span>
  );
}

/** A checks wait still waiting on its open PR, in the PR's checks: red while
 *  they fail, which keeps it waiting (TG2), so the page says why it is not moving. */
function ChecksWord({ wait, repository, pr_number }: { wait: TaskWait; repository: string; pr_number: number }) {
  const checks = useEntityResolution(`${repository}#${pr_number}`, "pr").entity?.checks_state;
  const word = waitStateWord(wait, { checks });
  return word ? <WaitWord word={word} fails={waitWordFails(wait, { checks })} /> : null;
}

/** A wait's word, red when it reads as a failure (`waitWordFails`), dim
 *  otherwise. `Line` truncates a detail at 45% of a column that is ~250px wide
 *  in the inline peek, and a word like `answered: <the answer>` is the most
 *  informative thing on the line, so it carries its full text as its title the
 *  way the time pill does. The word is worked out by whoever has the inputs
 *  for it (a checks wait reads the PR's checks), and passed in. */
function WaitWord({ word, fails }: { word: string; fails: boolean }) {
  return <span title={word} className={fails ? "text-xs text-sol-red" : DIM}>{word}</span>;
}

function WaitLine({ wait: w, now, status, onRemove }: { wait: TaskWait; now: number; status: string; onRemove: () => void }) {
  const closed = isTerminalTaskStatus(status);
  const pill =
    w.kind === "time" ? <PlainPill title={formatWaitTime(w.at, { absolute: true })}><Clock className="w-[1em] h-[1em]" />{formatWaitTime(w.at, { now })}</PlainPill>
    : w.kind === "decision" ? <EntityIdPill type="decision" shortId={w.decision} wide />
    : w.repository ? <EntityIdPill type="pr" id={`${w.repository}#${w.pr_number}`} certain wide />
    : <PlainPill><GitPullRequest className="w-[1em] h-[1em]" />#{w.pr_number}</PlainPill>;
  const word = waitStateWord(w, { now, closed });
  // Whether this line's word needs the PR's checks is the shared rule
  // (`checksWaitPr`), so this page and the phone fetch for the same waits.
  const checksPr = checksWaitPr(w, { closed });
  const detail = checksPr
    ? <ChecksWord wait={w} repository={checksPr.repository} pr_number={checksPr.pr_number} />
    : word ? <WaitWord word={word} fails={waitWordFails(w, { closed })} /> : undefined;
  return (
    <Line state={w.state} status={status} onRemove={onRemove} removeLabel={`Remove the wait ${clauseOf(w, { now })}`} detail={detail}>
      {pill}
    </Line>
  );
}

type IsClosed = (ref: string) => boolean;

/** Task links, one titled pill per line as Blocked by lists them, a closed
 *  one dim like a met blocker, each removable when `onRemove` is given. The
 *  empty leading box is `Line`'s state glyph: every value in the grid starts
 *  at one left edge, so Blocks reads as a continuation of Blocked by. */
function TaskLinks({ refs, isClosed, onRemove, removeLabel }: { refs: string[]; isClosed: IsClosed; onRemove?: (ref: string) => void; removeLabel?: (ref: string) => string }) {
  return refs.map((ref) => (
    <div key={ref} className={`group/line flex items-center gap-1.5 min-w-0 ${LINE_H} text-xs ${isClosed(ref) ? "opacity-60" : ""}`}>
      <span className={GLYPH} />
      <EntityIdPill type="task" shortId={ref} wide />
      {onRemove && <RemoveButton label={removeLabel?.(ref) ?? `Remove ${ref}`} onClick={() => onRemove(ref)} />}
    </div>
  ));
}

/** The quiet add control closing a row, with its palette key (if it has one) on hover. */
function AddButton({ label, hotkey, plus, onClick }: { label: string; hotkey?: string; plus: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group/add h-5 flex items-center gap-1.5 text-xs text-sol-text-dim hover:text-sol-text focus-visible:text-sol-text text-left transition-colors w-fit rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan focus-visible:outline-offset-2">
      {plus && <Plus className="w-3 h-3" />}
      {label}
      {hotkey && <span className="opacity-0 group-hover/add:opacity-100 group-focus-visible/add:opacity-100 transition-opacity"><KeyCap size="xs">{hotkey}</KeyCap></span>}
    </button>
  );
}

/** Remove a task blocker under every form `blocked_by` names it by: a form
 *  left behind would bring the line back. One write, since the server drops
 *  every form of the edge it is named by. A blocker that names no task is
 *  not offered back: the server would refuse to set it again. */
function removeBlocker(id: string, line: Extract<BlockerLine, { kind: "task" }>) {
  const write = () => useInboxStore.getState().removeBlocker(id, line.ref, line.raws);
  if (line.state === "missing") withoutUndo(write);
  else undoAsOne(`Removed blocker ${line.ref} from ${id}`, write);
}

/** Detach the parent; the store refuses only a task it cannot find. The
 *  page's breadcrumb is where a subtask states its parent, so it carries this. */
export function removeTaskParent(id: string) {
  const r = setTaskParent(id, "");
  if (!r.ok) toast.error(r.reason);
}

export function TaskRelations({ task, tasks, onAdd }: { task: TaskItem; tasks: Record<string, TaskItem>; onAdd: (mode: RelationMode | "parent") => void }) {
  const now = useCoarseNow(60_000);
  const lines = useMemo(() => storeBlockerLines(task, tasks), [task, tasks]);
  const foundHere = useMemo(() => foundHereOf(task, tasks).map((t) => t.short_id), [task, tasks]);
  // Both mirrors as the server's reader prints them, so this page and `cast
  // task show` name the same tasks (TG12).
  const blocks = useMemo(() => blocksOf(task, tasks), [task, tasks]);
  const related = relatedOf(task);
  const statusOf = useMemo(() => storeStatusOf(tasks, task), [task, tasks]);
  const isClosed = useMemo<IsClosed>(() => (ref) => isTerminalTaskStatus(statusOf(ref)?.status), [statusOf]);
  // The positive verdict, in the shared words the phone uses (`isUnblocked`):
  // a task whose Blocked by row has lines, none of which still holds it. A
  // closed task is held by nothing by definition, so it says nothing.
  const terminal = isTerminalTaskStatus(task.status);
  const unblocked = lines.length > 0 && !terminal && isUnblocked(task, statusOf);
  // The parent itself is stated by the page's breadcrumb (one home per fact);
  // here it only decides whether "Set parent…" is on offer.
  const hasParent = !!task.parent_id;
  const store = useInboxStore.getState;
  const id = task.short_id;

  return (
    <>
      {(lines.length > 0 || !terminal) && (
        <RelationRow label="Blocked by">
          {/* The verdict leads, level with the label, and its lines below say
              who cleared: a reader never has to read every glyph to learn
              that nothing is holding this task. */}
          {unblocked && (
            <div className={`flex items-center gap-1.5 ${LINE_H} text-xs text-sol-green`} data-unblocked>
              <span className={GLYPH} />
              unblocked
            </div>
          )}
          {lines.map((line) =>
            line.kind === "task" ? (
              <TaskBlockerLine key={line.key} line={line} task={task} onRemove={() => removeBlocker(id, line)} />
            ) : (
              <WaitLine key={line.key} wait={line.wait} now={now} status={task.status} onRemove={() => store().removeWait(id, line.wait.id)} />
            ),
          )}
          {/* Nothing holds a closed task, so its page keeps the history and
              offers no add; with no lines left the row drops out entirely. */}
          {!terminal && <AddButton label="Add blocker…" hotkey="b" plus={lines.length > 0} onClick={() => onAdd("blocker")} />}
        </RelationRow>
      )}
      {blocks.length > 0 && (
        <RelationRow label="Blocks">
          <TaskLinks refs={blocks} isClosed={isClosed} onRemove={(ref) => store().removeBlocks(id, ref)} removeLabel={(ref) => `${ref} stops waiting on ${id}`} />
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
      {related.length > 0 && (
        <RelationRow label="Related">
          <TaskLinks refs={related} isClosed={isClosed} onRemove={(ref) => store().unrelateTasks(id, ref)} removeLabel={(ref) => `Unlink ${ref}`} />
          {/* The row only renders with lines above it, so its add indents into
              the glyph gutter like every other add on a row that has lines. */}
          <AddButton label="Link related…" hotkey="k" plus onClick={() => onAdd("related")} />
        </RelationRow>
      )}
      {(related.length === 0 || !hasParent) && (
        <RelationRow label="">
          <div className="flex items-center gap-4">
            {related.length === 0 && <AddButton label="Link related…" hotkey="k" plus={false} onClick={() => onAdd("related")} />}
            {!hasParent && <AddButton label="Set parent…" hotkey="t" plus={false} onClick={() => onAdd("parent")} />}
          </div>
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

/** Why the palette's query is no relation: set once it matches no task and
 *  reads as no ref. The hint shows it, in place of the list's "No results". */
export function relationQueryError(search: string, mode: RelationMode, matched: boolean) {
  const parsed = matched ? null : parseRelationQuery(search, mode);
  return parsed && "error" in parsed ? parsed : null;
}

/** Under the palette's field: the refs it reads (TG3). Once the query reads
 *  as none, a short lead says so, then the forms again, or what is wrong
 *  with a ref that has a ref's shape ("is in the past"). */
export function RelationQueryHint({ mode, search, matched, targets }: { mode: RelationMode; search: string; matched: boolean; targets: TaskItem[] }) {
  const error = relationQueryError(search, mode, matched);
  const forms = mode === "blocker" ? blockerForms(targets) : ["ct-12"];
  return (
    <div className="px-4 py-1.5 border-b border-sol-border/30 text-[10px] text-sol-text-dim" data-relation-hint>
      <span className="flex items-center gap-1 flex-wrap">
        {error && <span className="text-sol-red">{mode === "blocker" ? "Not a blocker." : "Not a task."}</span>}
        {error && !error.unrecognized ? (
          <span className="text-sol-text-muted">{error.error}</span>
        ) : (
          <>
            Search a task, or paste
            {forms.map((f, i) => (
              <span key={f} className="inline-flex items-center gap-1">
                {i > 0 && <span aria-hidden>·</span>}
                <span><code className="font-mono text-sol-text-muted">{f}</code>{i === forms.length - 1 && ","}</span>
              </span>
            ))}
            then <KeyCap size="xs">↵</KeyCap>
          </>
        )}
      </span>
    </div>
  );
}
