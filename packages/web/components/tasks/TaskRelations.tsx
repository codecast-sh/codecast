"use client";
/**
 * The task page's relations (docs/architecture/task-graph.md TG12), rows of
 * its property grid: one editable Blocked by row listing task blockers and
 * waits together, then Blocks, Found during, Found during this and Related,
 * each shown once it has something in it. Each line carries its live pill, its
 * state and a remove control; "Add blocker…" opens the palette, which takes a
 * task search or any blocker ref (TG3). Blocks edits the same edge from the
 * other side ("Add blocked task…"), and one last line offers whichever adds
 * have no row of their own yet. The parent is stated once, by the page's
 * breadcrumb, which carries its own remove.
 *
 * Everything reads the store's task rows and writes through store actions
 * (addBlocker, removeBlocker, removeBlocks, removeWait, unrelateTasks, and
 * updateTask for found_during), so a change paints at once and the side effect
 * makes the real write. Found during this is the mirror, derived from other
 * rows' found_during, so it is the one read-only row.
 */
import { useMemo, type ReactNode } from "react";
import { CircleDashed, Clock, GitPullRequest, Plus, Replace, X } from "lucide-react";
import { BLOCKER_NOT_FOUND_WORDS, BLOCKER_UNKNOWN_WORDS, checksWaitPr, formatWaitTime, isTerminalTaskStatus, isUnblocked, waitStateWord, waitWordFails, type TaskWait } from "@codecast/shared/tasks";
import { EntityIdPill } from "../EntityIdPill";
import { useInboxStore, type TaskItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useEntityResolution } from "../../lib/entityDisplay";
import { blockerForms, blocksOf, clauseOf, foundHereOf, lineStateLabel, relatedOf, relationQueryError, storeBlockerLines, type BlockerLine, type RelationMode } from "../../lib/taskRelations";
import { storeStatusOf, waitStateStyle, WAIT_STATE_STYLE } from "../../lib/taskBlockers";
import { workspaceKeyOfRow } from "../../lib/workspaceScope";
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
function Line({ state, subject, status, children, detail, onRemove, removeLabel }: { state: LineState; subject: "blocker" | "wait"; status: string; children: ReactNode; detail?: ReactNode; onRemove: () => void; removeLabel: string }) {
  const style = state === "missing" ? null : waitStateStyle(state, status, { untilClosed: true });
  // The glyph is the only thing a met line carries, so its accessible name
  // says what is met (`lineStateLabel`), never the bare state value. A
  // missing line is the exception: it prints those same words in its detail
  // slot, so naming its glyph too would say "not found" twice.
  let glyph = <CircleDashed className="w-3 h-3 text-sol-text-dim" aria-hidden />;
  if (state !== "missing" && style) {
    glyph = <style.icon className={`w-3 h-3 ${style.text}`} role="img" aria-label={lineStateLabel(state, subject)} />;
  }
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
    <Line state={met ? "met" : "waiting"} subject="blocker" status={task.status} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}>
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
    <Line state={missing ? "missing" : "waiting"} subject="blocker" status={task.status} onRemove={onRemove} removeLabel={`Remove blocker ${line.ref}`}
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
    <Line state={w.state} subject="wait" status={status} onRemove={onRemove} removeLabel={`Remove the wait ${clauseOf(w, { now })}`} detail={detail}>
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

/** What the Blocks add says under the "Blocks" label, which says which way
 *  the edge points. On the closing line there is no label above it, and
 *  "Add blocked task…" beside "Add blocker…" leaves the direction to one
 *  word, so there the add names the whole act (BLOCKS_ADD_CLOSING). */
const BLOCKS_ADD = "Add blocked task…";
const BLOCKS_ADD_CLOSING = "Make a task wait on this…";
/** The same for Related, which also sits either on its own row or the closing one. */
const RELATED_ADD = { label: "Link related task…", hotkey: "k" };
/** What Found during offers. The link is the server's GUESS from the filing
 *  session's bound task (TG5), and this page is where a person notices it is
 *  wrong, so it is set and repointed here as well as from the CLI. Set on the
 *  closing line when there is none, repointed on its own row when there is.
 *  The set reads as the palette it opens words its field ("Found while
 *  working on — search tasks…"), since on the closing line no label says
 *  what the relation is. */
const FOUND_DURING_ADD = "Found while working on…";
const FOUND_DURING_REPOINT = "Found during something else…";

/** The quiet add control closing a row, with its palette key beside it.
 *  Muted rather than dim at rest: on a fresh task the Blocked by row holds
 *  nothing but its label and this button, and an action in the label's own
 *  colour does not read as one. The cap is drawn at rest rather than revealed
 *  on hover: these are actions a person has never used, so the key is worth
 *  discovering, and a hidden cap still reserves its width — which on the
 *  closing row made the gap after a keyless button read as a typo. */
function AddButton({ label, hotkey, plus, onClick }: { label: string; hotkey?: string; plus: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="h-5 flex items-center gap-1.5 text-xs text-sol-text-muted hover:text-sol-text focus-visible:text-sol-text text-left transition-colors w-fit rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan focus-visible:outline-offset-2">
      {plus && <Plus className="w-3 h-3" />}
      {label}
      {hotkey && <KeyCap size="xs">{hotkey}</KeyCap>}
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
  // Every add whose own row is not there to hold it, on one closing line in
  // the rows' order, so no row is drawn empty just to carry its button.
  const closing = useMemo(() => [
    ...(blocks.length === 0 && !terminal ? [{ mode: "blocks" as const, label: BLOCKS_ADD_CLOSING }] : []),
    ...(related.length === 0 ? [{ mode: "related" as const, ...RELATED_ADD }] : []),
    ...(task.found_during ? [] : [{ mode: "found_during" as const, label: FOUND_DURING_ADD }]),
    ...(hasParent ? [] : [{ mode: "parent" as const, label: "Set parent…", hotkey: "t" }]),
  ], [related.length, blocks.length, terminal, hasParent, task.found_during]);
  const store = useInboxStore.getState;
  const id = task.short_id;

  return (
    <>
      {(lines.length > 0 || !terminal) && (
        /* On a closed task every line is history — nothing holds a closed
           task — so the row says so in its heading, the words `cast task
           show` uses for the same section. Without it a done task whose PR
           wait never settled reads as a live wait: a dim hourglass, a bare
           pill, and no word at all, since the verdict is suppressed and an
           unsettled wait on a closed task has no state word. */
        <RelationRow label={terminal ? "Blocked by (cleared)" : "Blocked by"}>
          {/* The verdict leads, level with the label, and its lines below say
              who cleared: a reader never has to read every glyph to learn
              that nothing is holding this task. */}
          {unblocked && (
            <div className={`flex items-center gap-1.5 ${LINE_H} text-xs text-sol-green`} data-unblocked>
              {/* The met glyph, so the verdict scans as a state like the lines
                  below it rather than as a stray label in a marked column.
                  The word stays "unblocked" (TG12). */}
              <span className={GLYPH}><WAIT_STATE_STYLE.met.icon className="w-3 h-3 text-sol-green" aria-hidden /></span>
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
          <TaskLinks refs={blocks} isClosed={isClosed} onRemove={(ref) => store().removeBlocks(id, ref)} removeLabel={(ref) => `Stop ${ref} waiting on this`} />
          {/* The row edits from this side both ways: the palette writes the
              same edge with its ends swapped, so "make ct-9 wait on this"
              never means opening ct-9. */}
          {!terminal && <AddButton label={BLOCKS_ADD} plus onClick={() => onAdd("blocks")} />}
        </RelationRow>
      )}
      {task.found_during && (
        <RelationRow label="Found during">
          {/* Removable and repointable: the server fills this from whatever
              task the creating session was bound to, so the one it filled in
              can be wrong, and the board is where that is noticed. */}
          <TaskLinks refs={[task.found_during]} isClosed={isClosed}
            onRemove={() => undoAsOne(`Cleared what ${id} was found during`, () => store().updateTask(id, { found_during: "" }))}
            removeLabel={(ref) => `Clear ${ref} as where this was found`} />
          <AddButton label={FOUND_DURING_REPOINT} plus={false} onClick={() => onAdd("found_during")} />
        </RelationRow>
      )}
      {foundHere.length > 0 && (
        <RelationRow label="Found during this">
          <TaskLinks refs={foundHere} isClosed={isClosed} />
        </RelationRow>
      )}
      {related.length > 0 && (
        <RelationRow label="Related">
          <TaskLinks refs={related} isClosed={isClosed} onRemove={(ref) => store().unrelateTasks(id, ref)} removeLabel={(ref) => `Unlink ${ref}`} />
          {/* The row only renders with lines above it, so its add indents into
              the glyph gutter like every other add on a row that has lines. */}
          <AddButton {...RELATED_ADD} plus onClick={() => onAdd("related")} />
        </RelationRow>
      )}
      {closing.length > 0 && (
        <RelationRow label="">
          <div className="flex items-center gap-4 flex-wrap">
            {closing.map((o) => (
              <AddButton key={o.mode} label={o.label} hotkey={o.hotkey} plus={false} onClick={() => onAdd(o.mode)} />
            ))}
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
    <div className="flex items-center gap-2 min-w-0 mb-3 px-3 py-2 rounded-md border border-sol-border/30 bg-sol-bg-alt/40 text-xs text-sol-text-muted" data-superseded>
      <Replace className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
      <span className="flex-shrink-0">Superseded by</span>
      {/* `wide` gives the pill min-w-0/max-w-full/truncate, so a replacement
          with a long title shrinks instead of pushing past the banner — the
          inline peek's value column is only ~250px wide. */}
      <EntityIdPill type="task" shortId={task.superseded_by} wide />
    </div>
  );
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
