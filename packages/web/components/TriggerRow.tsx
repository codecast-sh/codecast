"use client";

// ONE trigger row, everywhere a trigger renders as a row: the inbox dock
// roster, the bars stacked under a session card, and the /triggers page. One
// anatomy, so the surfaces cannot drift and a reader learns it once:
//
//   ● Title ──────────────────────────── cadence  [next fire]
//     what each run does, one line
//     ✓ 2h ago · 6 runs · what the last run said, one line
//
// Line two is ALWAYS the standing description and line three is ALWAYS the
// last outcome — never one standing in for the other. Every line is one
// line: the title and the two sentences truncate, nothing wraps, so a roster
// of fifty rows scans at a fixed rhythm and a long agent report can't turn a
// row into a page. The full text rides the tooltip; the trigger page has it
// all. Under a card (attached) the row folds to two lines: the outcome meta
// (glyph + age) shares the description's line.
//
// Two INDEPENDENT facts a row carries, kept apart so their colors can't blur:
//   • the LEFT ACCENT = health/liveness — red ONLY when a run failed or the
//     agent flagged it (red always means "look at this"); green while running;
//     dim when paused or finished; else the calm schedule-amber.
//   • the BADGE = the NEXT fire — a soft amber tint at rest, brighter when
//     imminent (<10m), and never red: "about to fire" is not "went wrong".
//     Finished one-times wear "done" / "failed" in the same slot.

import { memo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { WorkState } from "@codecast/shared/contracts";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Copy, History, Pause, Pencil, Play, RotateCcw, Trash2, X, XCircle } from "lucide-react";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator } from "./ui/context-menu";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { StatusDot } from "./StatusDot";
import { ORG_STATE_META } from "./org/orgMeta";
import { useCoarseNow, useNowWhen } from "../hooks/useCoarseNow";
import { useInboxStore, classifySession, isSessionHidden, getProjectName, type InboxSession } from "../store/inboxStore";
import { threadStateView } from "../lib/threadState";
import { cleanTitle } from "../lib/conversationProcessor";
import { getLabelColor } from "../lib/labelColors";
import { copyToClipboard } from "../lib/utils";
import { fmtClock, fmtDuration, describeTaskCadence, isTaskOverdue, taskStateLabel } from "./triggerCadence";
import { taskDisplayTitle, taskGist, lastRunHeadline, type TriggerRow, type TriggerHomeGroup, type TaskRow } from "./triggerTasks";
import { TriggerRunList, useTriggerRuns } from "./TriggerRunHistory";

export type SchedAccent = "running" | "attention" | "paused" | "normal";
export function schedAccent(task: { status: string; last_run_failed?: boolean; last_run_needs_attention?: boolean }): SchedAccent {
  if (task.status === "running") return "running";
  if (task.status === "failed" || task.last_run_failed || task.last_run_needs_attention) return "attention";
  if (task.status === "paused" || task.status === "completed") return "paused";
  return "normal";
}
const SCHED_ACCENT: Record<SchedAccent, string> = {
  running: "border-l-sol-green",
  attention: "border-l-sol-red",
  paused: "border-l-sol-border",
  normal: "border-l-sol-amber/50",
};
function schedBadgeTone(task: { status: string; run_at?: number }, now: number): string {
  if (task.status === "paused" || task.status === "completed") return "bg-sol-bg-alt text-sol-text-dim border-sol-border/50";
  if (task.status === "failed") return "bg-sol-red/10 text-sol-red border-sol-red/30";
  if (task.status === "running") return "bg-sol-green/10 text-sol-green border-sol-green/30";
  // Stuck-due is the one badge state that earns red: the daemon should claim
  // due work within seconds, so minutes overdue means nothing is listening.
  if (isTaskOverdue(task, now)) return "bg-sol-red/10 text-sol-red border-sol-red/40 font-bold";
  const ms = task.run_at !== undefined ? task.run_at - now : undefined;
  if (ms !== undefined && ms <= 10 * 60_000) return "bg-sol-amber/20 text-sol-amber border-sol-amber/50 font-bold";
  return "bg-sol-amber/[0.08] text-sol-amber/90 border-sol-amber/25";
}

// The ↳ corner arrow an attached/grouped row wears — the SAME glyph the
// subagent rows carry (in schedule-amber, not subagent violet), so the child
// connectors line up under a card and the amber alone says "schedule".
export function SchedChildArrow({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`flex items-center mt-[2px] shrink-0 ${className ?? "text-sol-amber/70"}`} role="img" aria-label={label}>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <title>{label}</title>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
      </svg>
    </span>
  );
}

// The health dot beside a schedule's name: green pulse while a run is live,
// red when the last run failed or flagged itself; nothing at rest.
export function SchedHealthDot({ accent, task }: { accent: SchedAccent; task: { last_run_failed?: boolean } }) {
  if (accent === "running") {
    return (
      <ShortcutTooltip label="Running now">
        <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
          <span className="absolute inline-flex h-2 w-2 rounded-full bg-sol-green/40 animate-ping motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sol-green" />
        </span>
      </ShortcutTooltip>
    );
  }
  if (accent === "attention") {
    return (
      <ShortcutTooltip label={task.last_run_failed ? "Last run failed" : "Flagged for attention"}>
        <span className="w-1.5 h-1.5 rounded-full bg-sol-red shrink-0" />
      </ShortcutTooltip>
    );
  }
  return null;
}

// The next-fire badge — one tone function, one label function, so every
// surface shows the same countdown for the same schedule. Memoized on its own
// label-keyed clock: a badge re-renders only when its text would change.
export const SchedFireBadge = memo(function SchedFireBadge({ task, className = "" }: { task: TaskRow; className?: string }) {
  const now = useNowWhen((t) => taskStateLabel(task, t), 30_000);
  const badge = (
    <span className={`${className} shrink-0 inline-flex items-center justify-center min-w-[46px] px-1 py-0 rounded text-[9px] font-semibold tabular-nums border transition-colors ${schedBadgeTone(task, now)}`}>
      {taskStateLabel(task, now)}
    </span>
  );
  if (task.status !== "scheduled") return badge;
  const cadence = describeTaskCadence(task);
  return (
    <ShortcutTooltip label={task.run_at !== undefined ? `Fires at ${fmtClock(task.run_at)}` : `Fires ${cadence}`} hint={task.run_at !== undefined ? cadence : undefined}>
      {badge}
    </ShortcutTooltip>
  );
});

// The outcome glyph + word, shared by the row's third line and the attached
// row's right-hand meta. One vocabulary: ok / failed / flagged.
function outcomeOf(task: TaskRow) {
  if (task.last_run_failed) return { Icon: XCircle, tone: "text-sol-red", word: "failed" };
  if (task.last_run_needs_attention) return { Icon: AlertTriangle, tone: "text-sol-orange", word: "flagged" };
  return { Icon: CheckCircle2, tone: "text-sol-green", word: "ok" };
}

export type TriggerRowVariant =
  // Under its owning session card: two lines, ↳ arrow, no accent rail.
  | "attached"
  // In the dock roster under a home-session header: ↳ arrow, three lines.
  | "grouped"
  // In the dock roster with no header above.
  | "roster"
  // On /triggers: the same three lines with room to breathe, plus the
  // page-only verbs (edit, duplicate, delete).
  | "page";

const VERB_BTN = "p-1 rounded transition-[color,background-color,transform] duration-100 active:scale-90";

export const TriggerRowItem = memo(function TriggerRowItem({
  row, variant = "roster", activeSessionId, onOpen, highlighted, isNext, onNavigated, onEdit, onDuplicate, onDelete,
}: {
  row: TriggerRow;
  variant?: TriggerRowVariant;
  activeSessionId?: string | null;
  // The row's primary click. Rosters open the conversation behind the
  // schedule; the page opens the trigger's own page.
  onOpen: (row: TriggerRow) => void;
  // Keyboard cursor (roster arrow-nav) or deep-link target — visual only.
  highlighted?: boolean;
  // The soonest fire on the page, marked "next up".
  isNext?: boolean;
  // Called after a run-history click navigated away — the dock roster passes
  // its close() so the overlay doesn't linger over the new conversation.
  onNavigated?: () => void;
  // Page-only verbs; a surface that passes none of them shows none of them.
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const { task, unread } = row;
  const router = useRouter();
  const attached = variant === "attached";
  const page = variant === "page";
  const arrow = attached || variant === "grouped";
  // Pseudo rows (harness loops) wear the same anatomy but carry no server
  // verbs — there's no agent_tasks row to pause or cancel, and no run history
  // to query. See triggerTasks.ts.
  const isPseudo = !!row.kind;
  const now = useCoarseNow(30_000);
  // Every verb is a store action (local-first): the agent_tasks row flips on
  // the draft the instant it's clicked and the dispatch side effect runs the
  // real mutation. Same actions on every surface.
  const triggerAction = useInboxStore((st) => st.triggerAction);
  const taskId = task._id as Id<"agent_tasks">;
  const runNow = () => { triggerAction(taskId, "runNow"); toast.success("Run queued"); };
  const runAgain = () => { triggerAction(taskId, "reactivate"); toast.success("Re-armed — runs within ~30s"); };
  const pause = () => triggerAction(taskId, "pause");
  const resume = () => triggerAction(taskId, "resume");
  const cancel = () => {
    triggerAction(taskId, "cancel");
    toast("Trigger canceled", { description: taskDisplayTitle(task), action: { label: "Undo", onClick: () => triggerAction(taskId, "reactivate") } });
  };
  const paused = task.status === "paused";
  const terminal = task.status === "completed" || task.status === "failed";
  const editable = !isPseudo && !!onEdit && (task.status === "scheduled" || task.status === "paused");
  const isActive = !!row.openId && row.openId === activeSessionId;
  const accent = schedAccent(task);
  const title = taskDisplayTitle(task);
  const gist = taskGist(task);
  const pagePath = `/triggers/${task.short_id ?? task._id}`;
  // Click feedback: an amber wash that fades (keyed so re-clicks re-trigger).
  // Selection alone can't confirm the click — the row's session is often
  // already active — so the schedule-amber pulse says "this row heard you".
  const [clickFlash, setClickFlash] = useState(0);
  // Inline run history (the hover rail's History verb). Query only while
  // open, so a resting roster costs nothing.
  const [runsOpen, setRunsOpen] = useState(false);
  const runs = useTriggerRuns(runsOpen && !isPseudo ? task._id : null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ctxMenu = useContextMenu<void>();

  // ── The outcome line ──
  const outcome = outcomeOf(task);
  const ago = task.last_run_at !== undefined ? `${fmtDuration(Math.max(0, now - task.last_run_at))} ago` : undefined;
  const headline = lastRunHeadline(task);
  const skipped = task.last_precheck_skip_at !== undefined && task.last_precheck_skip_at > (task.last_run_at ?? 0);
  const retrying = (task.retry_count ?? 0) > 0 && (
    <ShortcutTooltip label="The last run errored; the daemon is retrying">
      <span className="shrink-0 text-sol-red/80 font-medium">retrying ×{task.retry_count}</span>
    </ShortcutTooltip>
  );
  const runsLabel = task.run_count > 0 ? `${task.run_count} run${task.run_count === 1 ? "" : "s"}` : undefined;
  const outcomeTip = task.last_run_summary
    ? { label: task.last_run_summary, hint: `last run ${outcome.word}${task.last_run_at ? ` at ${fmtClock(task.last_run_at)}` : ""}` }
    : undefined;
  const dot = "text-sol-text-dim/60";
  const sep = <span className={`shrink-0 ${dot}`}>·</span>;
  const outcomeLine = isPseudo ? null : (
    <div className={`flex items-center gap-1.5 min-w-0 ${page ? "text-[11px]" : "text-[10px]"} tabular-nums`}>
      {ago ? (
        <>
          <outcome.Icon className={`w-3 h-3 shrink-0 ${outcome.tone}`} />
          <span className={`shrink-0 ${outcome.tone} font-medium`}>{outcome.word}</span>
          <span className="shrink-0 text-sol-text-dim">{ago}</span>
          {runsLabel && (<>{sep}<span className="shrink-0 text-sol-text-dim">{runsLabel}</span></>)}
          {retrying && (<>{sep}{retrying}</>)}
          {headline && (
            <>
              {sep}
              <span className="truncate min-w-0 text-sol-text-muted">{headline}</span>
            </>
          )}
        </>
      ) : skipped ? (
        <>
          <span className="w-[7px] h-[7px] mx-px rounded-full border border-sol-text-dim/70 shrink-0" />
          <span className="shrink-0 text-sol-text-dim">skipped {fmtDuration(Math.max(0, now - task.last_precheck_skip_at!))} ago</span>
          {task.last_precheck_skip_reason && (<>{sep}<span className="truncate min-w-0 text-sol-text-muted">{task.last_precheck_skip_reason}</span></>)}
        </>
      ) : (
        <>
          <span className="w-[7px] h-[7px] mx-px rounded-full border border-sol-text-dim/50 shrink-0" />
          <span className="text-sol-text-dim">
            {task.status === "scheduled" && task.run_at !== undefined && task.run_at > now
              ? `no runs yet · first fires ${fmtClock(task.run_at)}`
              : "no runs yet"}
          </span>
        </>
      )}
    </div>
  );
  const wrapTip = (el: React.ReactNode) =>
    outcomeTip ? <ShortcutTooltip label={outcomeTip.label} hint={outcomeTip.hint}>{el}</ShortcutTooltip> : el;

  const open = () => {
    setClickFlash((n) => n + 1);
    onOpen(row);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      data-schedrow={task._id}
      data-attached={attached || undefined}
      data-row-active={isActive || undefined}
      onContextMenu={!isPseudo ? (e) => ctxMenu.open(e, undefined) : undefined}
      className={`group/schedrow relative transition-colors ${
        // Attached rows sit flush under their card — no separator line above
        // and no left accent bar; the ↳ arrow carries the parent/child
        // connection and the title dot carries health.
        attached ? "" : "border-b border-sol-border/30"
      } ${
        isActive
          ? attached ? "bg-sol-cyan/[0.10]" : "border-l-2 border-l-sol-cyan/60 bg-sol-cyan/[0.10]"
          : attached ? "" : `border-l-2 ${isNext ? "border-l-sol-cyan" : SCHED_ACCENT[accent]}`
      } ${
        highlighted ? "bg-[color-mix(in_srgb,var(--sol-bg-alt)_70%,transparent)] ring-1 ring-inset ring-sol-amber/40" : ""
      }`}
    >
      {/* Inner relative wrapper: the click-flash and the hover verb rail size
          to the ROW only, so an expanded run history below never sits under
          the rail's gradient or its hover targets. */}
      <div className="relative">
        {/* A div, not a <button>: the title inside is a real link to the
            trigger page, and a link may not nest in a button. */}
        <div
          role="button"
          tabIndex={0}
          onClick={open}
          onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); }}
          className={`w-full text-left cursor-pointer transition-[background-color,opacity] hover:bg-sol-amber/[0.05] ${
            page ? "px-4 py-2.5" : attached ? "pl-2 pr-3 py-1" : "pl-2.5 pr-3 py-1.5"
          } ${paused ? "opacity-55 hover:opacity-90" : ""}`}
        >
          <div className="flex gap-1.5 min-w-0">
            {arrow && <SchedChildArrow label={row.kind === "loop" ? "Loop — the agent wakes itself in this session" : "Trigger — fires into this session"} />}
            <div className={`min-w-0 flex-1 ${page ? "space-y-1" : "space-y-0.5"}`}>
              {/* ── Line 1: name · cadence · next fire ── */}
              <div className="flex items-center gap-1.5 min-w-0">
                <SchedHealthDot accent={accent} task={task} />
                {/* The name is the link to the trigger's own page: hover
                    underlines it and grows the ↗. Attached rows recede to the
                    same muted treatment the subagent child rows use. */}
                {isPseudo ? (
                  <span className={`truncate min-w-0 ${page ? "text-[13px]" : "text-xs"} ${attached ? "text-gray-400 font-normal" : "text-sol-text font-medium"}`}>{title}</span>
                ) : (
                  <ShortcutTooltip label={title} hint="open the trigger page" side="top">
                    <Link
                      href={pagePath}
                      onClick={stop}
                      className={`group/title inline-flex items-center gap-1 min-w-0 no-underline hover:underline decoration-sol-amber/60 underline-offset-2 ${
                        page ? "text-[13px]" : "text-xs"
                      } ${attached ? "text-gray-400 font-normal" : terminal ? "text-sol-text-muted font-medium" : "text-sol-text font-medium"}`}
                    >
                      <span className="truncate min-w-0">{title}</span>
                      <ArrowUpRight className="w-3 h-3 shrink-0 text-sol-amber opacity-0 group-hover/title:opacity-100 transition-opacity" />
                    </Link>
                  </ShortcutTooltip>
                )}
                {isNext && <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-sol-cyan">next up</span>}
                {unread && !attached && (
                  <ShortcutTooltip label="Outcome landed since you last opened this list">
                    <span className="shrink-0 px-1 rounded-full bg-sol-amber/15 text-sol-amber text-[9px] font-medium">new</span>
                  </ShortcutTooltip>
                )}
                {/* Cadence text stays off attached rows (the countdown is
                    enough under a card; the cadence rides its tooltip). */}
                {(row.kind === "loop" || !attached) && (
                  <span className="ml-auto shrink-0 text-[10px] font-medium text-sol-text-muted">
                    {row.kind === "loop" ? "loop" : describeTaskCadence(task)}
                  </span>
                )}
                <SchedFireBadge task={task} className={attached && row.kind !== "loop" ? "ml-auto" : ""} />
              </div>
              {/* ── Line 2: what each run does (+ outcome meta when attached) ── */}
              <div className="flex items-center gap-1.5 min-w-0">
                <ShortcutTooltip label={gist} hint={task.display_summary ? undefined : "from the prompt — a summary is on its way"}>
                  <span className={`block min-w-0 flex-1 truncate ${page ? "text-xs" : "text-[11px]"} leading-snug text-sol-text-dim`}>{gist}</span>
                </ShortcutTooltip>
                {attached && ago && !isPseudo && wrapTip(
                  <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] tabular-nums ${outcome.tone}`}>
                    <outcome.Icon className="w-3 h-3" />
                    <span className="text-sol-text-dim">{ago}</span>
                  </span>,
                )}
                {attached && retrying}
              </div>
              {/* ── Line 3: the last run ── */}
              {!attached && outcomeLine && wrapTip(outcomeLine)}
            </div>
          </div>
        </div>
        {clickFlash > 0 && <span key={clickFlash} aria-hidden className="sched-click-flash absolute inset-0 pointer-events-none" />}
        {/* Hover action rail — a right-hand strip that fades in over a
            gradient, holding compact icon verbs. Absolute + full-height so
            revealing it never changes the row's height. */}
        {!isPseudo && (
          <div className="absolute top-0 bottom-0 right-0 flex items-center gap-0.5 pl-12 pr-2 opacity-0 group-hover/schedrow:opacity-100 transition-opacity duration-150 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] bg-gradient-to-r from-transparent via-[color-mix(in_srgb,var(--sol-bg-alt)_80%,transparent)] to-sol-bg-alt">
            <ShortcutTooltip label={runsOpen ? "Hide run history" : "Run history"} hint="every run links to its trigger message" side="top">
              <button
                aria-label={runsOpen ? "Hide run history" : "Show run history"}
                aria-expanded={runsOpen}
                onClick={(e) => { stop(e); setRunsOpen((v) => !v); }}
                className={`${VERB_BTN} ${runsOpen ? "text-sol-amber bg-sol-amber/10" : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt"}`}
              >
                <History className="w-3.5 h-3.5" />
              </button>
            </ShortcutTooltip>
            {!page && (
              <ShortcutTooltip label="Open trigger page" hint="full detail, history, edit" side="top">
                <Link href={pagePath} aria-label="Open trigger page" onClick={stop} className={`${VERB_BTN} text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt`}>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
              </ShortcutTooltip>
            )}
            {editable && (
              <ShortcutTooltip label="Edit" side="top">
                <button aria-label="Edit" onClick={(e) => { stop(e); onEdit!(); }} className={`${VERB_BTN} text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt`}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
            )}
            {terminal ? (
              <ShortcutTooltip label="Run again" hint="re-arms, runs within ~30s" side="top">
                <button aria-label="Run again" onClick={(e) => { stop(e); runAgain(); }} className={`${VERB_BTN} text-sol-text-dim hover:text-sol-amber hover:bg-sol-amber/10`}>
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
            ) : task.status !== "running" && (
              <ShortcutTooltip label="Run now" side="top">
                <button aria-label="Run now" onClick={(e) => { stop(e); runNow(); }} className={`${VERB_BTN} text-sol-text-dim hover:text-sol-amber hover:bg-sol-amber/10`}>
                  <Play className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />
                </button>
              </ShortcutTooltip>
            )}
            {!terminal && (
              <ShortcutTooltip label={paused ? "Resume trigger" : "Pause trigger"} side="top">
                <button
                  aria-label={paused ? "Resume trigger" : "Pause trigger"}
                  onClick={(e) => { stop(e); if (paused) resume(); else pause(); }}
                  className={`${VERB_BTN} text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt`}
                >
                  {paused ? <Play className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} /> : <Pause className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />}
                </button>
              </ShortcutTooltip>
            )}
            {terminal && onDelete && (
              <ShortcutTooltip label={confirmDelete ? "Click again to delete" : "Delete"} side="top">
                <button
                  aria-label="Delete"
                  onClick={(e) => {
                    stop(e);
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      setTimeout(() => setConfirmDelete(false), 3000);
                      return;
                    }
                    onDelete();
                  }}
                  className={`${VERB_BTN} ${confirmDelete ? "text-sol-red bg-sol-red/10" : "text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10"}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
            )}
          </div>
        )}
      </div>
      {/* Past runs, inline: every run of this schedule, newest first, each
          entry landing on the message that triggered it. */}
      {runsOpen && !isPseudo && (
        <div className={`${page ? "pl-4" : arrow ? "pl-6" : "pl-2.5"} pr-2 pb-1.5`} onClick={stop}>
          {runs === undefined ? (
            <div className="text-[10px] text-sol-text-dim py-1 pl-1.5">Loading runs…</div>
          ) : runs.length === 0 ? (
            <div className="text-[10px] text-sol-text-dim py-1 pl-1.5">No runs recorded yet</div>
          ) : (
            <TriggerRunList runs={runs} now={now} currentConversationId={activeSessionId} onOpened={onNavigated} ensureInboxRoute={page} />
          )}
        </div>
      )}
      {!isPseudo && (
        <ContextMenu state={ctxMenu}>
          {() => (
            <>
              <CtxHeader title={title} id={task.short_id} />
              {terminal ? (
                <CtxItem icon={RotateCcw} onSelect={runAgain}>Run again</CtxItem>
              ) : task.status !== "running" && (
                <CtxItem icon={Play} onSelect={runNow}>Run now</CtxItem>
              )}
              {!terminal && (
                <CtxItem icon={paused ? Play : Pause} onSelect={() => { if (paused) resume(); else pause(); }}>
                  {paused ? "Resume trigger" : "Pause trigger"}
                </CtxItem>
              )}
              <CtxItem icon={History} onSelect={() => setRunsOpen((v) => !v)}>{runsOpen ? "Hide run history" : "Run history"}</CtxItem>
              <CtxItem icon={ArrowUpRight} onSelect={() => router.push(pagePath)}>Open trigger page</CtxItem>
              {editable && <CtxItem icon={Pencil} onSelect={onEdit!}>Edit</CtxItem>}
              {onDuplicate && <CtxItem icon={Copy} onSelect={onDuplicate}>Duplicate</CtxItem>}
              <CtxSeparator />
              <CtxItem icon={Copy} onSelect={() => { copyToClipboard(task.prompt || ""); toast.success("Prompt copied"); }}>Copy prompt</CtxItem>
              <CtxSeparator />
              {terminal
                ? onDelete && <CtxItem danger icon={Trash2} onSelect={onDelete}>Delete</CtxItem>
                : <CtxItem danger icon={X} onSelect={cancel}>Cancel trigger</CtxItem>}
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
});

// The session a group of rows fires into, as the group's header: state dot,
// title, work-state word, project, and how many triggers it carries. A spawn
// group (no home — every run is a fresh session) says so and names the
// project instead. The home's pinned thread state rides the tooltip. Shared by
// the dock roster and the /triggers page so the two group the same way.
export function TriggerHomeHeader({ group, home, now, isActive, showProject, onOpen, size = "sm" }: {
  group: TriggerHomeGroup;
  home?: InboxSession;
  now: number;
  isActive: boolean;
  showProject: boolean;
  onOpen: () => void;
  size?: "sm" | "md";
}) {
  const count = group.rows.length;
  const projectPath = home?.project_path ?? home?.git_root ?? group.projectPath ?? group.rows[0].task.project_path;
  const project = showProject && projectPath ? getProjectName(undefined, projectPath) : undefined;
  const projectChip = project ? (
    <ShortcutTooltip label={projectPath!}>
      <span className={`shrink-0 px-1 rounded text-[9px] font-medium border ${getLabelColor(project).bg} ${getLabelColor(project).text} ${getLabelColor(project).border}`}>
        {project}
      </span>
    </ShortcutTooltip>
  ) : null;
  // A count only when there is something to count: "1 trigger" on every
  // header would be the roster's most repeated words.
  const countEl = (
    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sol-text-dim">
      {count > 1 ? `${count} ${group.rows.every((r) => r.kind === "loop") ? "loops" : "triggers"}` : ""}
    </span>
  );
  const pad = size === "md" ? "px-4 py-1.5" : "px-3 py-1";
  const shell = `w-full flex items-center gap-1.5 ${pad} text-left border-b border-sol-border/30 transition-colors ${
    isActive ? "bg-sol-cyan/[0.10]" : "bg-sol-bg-alt/40 hover:bg-sol-bg-alt/70"
  }`;
  if (!group.homeId) {
    return (
      <button onClick={onOpen} className={shell}>
        <ShortcutTooltip label="Every run starts a fresh session (--spawn)" hint="opens the newest run">
          <span aria-hidden className="w-2 h-2 shrink-0 rounded-full border border-dashed border-sol-amber/70" />
        </ShortcutTooltip>
        <span className="text-[11px] font-medium text-sol-text-muted truncate min-w-0">Fresh session per run</span>
        {projectChip}
        {countEl}
      </button>
    );
  }
  const verdict = home ? classifySession(home) : null;
  const ws: WorkState = !verdict ? "idle" : verdict.waiting ? verdict.rest : verdict.idle ? "idle" : "working";
  const meta = ORG_STATE_META[ws];
  const hidden = !!home && isSessionHidden(home);
  const title = home
    ? cleanTitle(home.title || "New Session")
    : group.rows[0].task.originating_conversation_title || "Session";
  const stateLine = home ? threadStateView(home, home.message_count, now)?.cardLine : undefined;
  const stateWord = home ? `${meta.label}${hidden ? " · stashed" : ""}` : "not loaded";
  return (
    <ShortcutTooltip label={stateLine ?? title} hint={stateLine ? `${meta.label} · open session` : "open session"} side="top">
      <button onClick={onOpen} className={shell} data-trigger-home={group.homeId}>
        <StatusDot color={meta.color} ping={ws === "working"} />
        <span className={`text-[11px] font-medium truncate min-w-0 ${hidden ? "text-sol-text-muted" : "text-sol-text"}`}>{title}</span>
        <span className="shrink-0 text-[10px]" style={{ color: meta.color }}>{stateWord}</span>
        {projectChip}
        {countEl}
      </button>
    </ShortcutTooltip>
  );
}
