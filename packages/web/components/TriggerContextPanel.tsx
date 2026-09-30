"use client";

import { copyToClipboard } from "../lib/utils";
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Pause,
  Play,
  X,
  XCircle,
} from "lucide-react";
import { describeTaskCadence, fmtClock, fmtDuration, isTaskOverdue, taskStateLabel } from "./triggerCadence";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import {
  ARMED_STATUSES,
  compareTriggerRoster,
  isLoopFresh,
  loopTaskRow,
  taskDisplayTitle,
  taskGist,
  type TaskRow,
} from "./triggerTasks";
import type { InboxSession } from "../store/inboxStore";
import { TriggerRunRail, useTriggerRuns, type TriggerRun } from "./TriggerRunHistory";
import { SchedFireBadge, SchedHealthDot } from "./TriggerRow";
import { schedAccent } from "../lib/triggerAccent";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useTriggers } from "../hooks/useSyncTriggers";
import { TriggerPromptView } from "./TriggerPromptView";

import { useWatchEffect } from "../hooks/useWatchEffect";
import { LivePulseDot } from "./SessionActivityLine";
const api = _api as any;

// The standing intent behind a session, surfaced where the user actually looks:
// a strip above the conversation (subHeaderContent, beside the plan/workflow
// panels). Shows what each trigger will do (title + full prompt), when
// (cadence + live countdown), what happened last (outcome + link to the last
// run), and the verbs (run now, pause/resume, cancel). Renders for the
// conversation a trigger injects into (originating), the one that created it,
// any spawned run of it (agent_task_id / run uuid), and the conversation that
// receives its summaries (target).
//
// One live trigger: the strip IS that trigger. Several: the strip is the set —
// a pill per trigger in roster order, which drills into one trigger's detail
// and back. A trigger row clicked in the inbox arrives focused on that trigger
// (triggerStripRequest); a card click arrives on the whole set.
//
// Data: the same store-fed roster the sidebar rows and /triggers use, plus the
// per-conversation query for triggers armed under another account.

// Pills the collapsed row shows before folding the rest into "+N".
const MAX_PILLS = 4;

export function TriggerContextPanel({
  conversationId,
  sessionId,
  agentTaskId,
}: {
  conversationId: string;
  sessionId?: string | null;
  agentTaskId?: string | null;
}) {
  // Store-fed (hooks/useSyncTriggers): the strip paints from the cached
  // roster on the first frame; the feeder keeps it fresh.
  const { tasks: taskList, ready: tasksReady } = useTriggers();
  const tasks = (tasksReady || taskList.length > 0 ? taskList : undefined) as TaskRow[] | undefined;

  // Requests from trigger surfaces (see triggerStripRequest). Subscribed (not
  // only a mount read) so a click also works when the conversation is ALREADY
  // open — no remount happens then. Consumed once, so a later revisit doesn't
  // re-apply a stale focus.
  const stripReq = useInboxStore((s) => s.triggerStripRequest);
  const [expanded, setExpanded] = useState(() => {
    const req = useInboxStore.getState().triggerStripRequest;
    return !!req && req.convId === conversationId && req.expand;
  });
  // The trigger the user drilled into; null = the whole set.
  const [focusedId, setFocusedId] = useState<string | null>(() => {
    const req = useInboxStore.getState().triggerStripRequest;
    return req && req.convId === conversationId ? req.taskId : null;
  });
  useWatchEffect(() => {
    if (!stripReq || stripReq.convId !== conversationId) return;
    setFocusedId(stripReq.taskId);
    if (stripReq.expand) setExpanded(true);
    useInboxStore.getState().setTriggerStripRequest(null);
  }, [stripReq, conversationId]);

  // The viewer's own roster can't carry a trigger armed under a different
  // account (a remote daemon logged in as a team bot). This per-conversation
  // query returns every trigger anchored HERE that the viewer may see — own
  // and foreign alike — so the strip never goes missing on the session that
  // created the trigger. No-throw: pure enrichment, and the query is newer
  // than some deployed backends.
  const { data: convTasks } = useQueryNoThrow(
    api.agentTasks.webListForConversation,
    isConvexId(conversationId) ? { conversation_id: conversationId } : "skip"
  );

  const matched = useMemo(() => {
    const own = (tasks ?? []).filter(
      (t) =>
        (agentTaskId && t._id === agentTaskId) ||
        t.originating_conversation_id === conversationId ||
        t.created_by_conversation_id === conversationId ||
        t.target_conversation_id === conversationId ||
        t.last_run_conversation_id === conversationId ||
        (sessionId && t.last_run_session_uuid === sessionId)
    );
    const seen = new Set(own.map((t) => t._id));
    const foreign = ((convTasks ?? []) as TaskRow[]).filter((t) => !seen.has(t._id));
    return [...own, ...foreign];
  }, [tasks, convTasks, conversationId, sessionId, agentTaskId]);

  // Coarse countdown clock — the shared 30s clock the badges ride (one timer
  // total, however many subscribers).
  const now = useCoarseNow(30_000);

  // Harness /loop on this session (server-folded loop_state; see loopState.ts):
  // the same anatomy via the pseudo TaskRow, minus the verbs. Narrow selectors
  // (never the whole row) so heartbeat churn can't re-render.
  const loopState = useInboxStore((st) => st.sessions[conversationId]?.loop_state ?? null);
  const sessionTitle = useInboxStore((st) => st.sessions[conversationId]?.title);
  const loopFresh = !!loopState && isLoopFresh(loopState, now);
  const loopRow = useMemo(
    () => (loopFresh && loopState ? loopTaskRow({ _id: conversationId, title: sessionTitle } as InboxSession, loopState) : null),
    [loopFresh, loopState, conversationId, sessionTitle],
  );

  const live = useMemo(
    () => liveTriggersFor(matched, loopRow, conversationId, sessionId, agentTaskId),
    [matched, loopRow, conversationId, sessionId, agentTaskId],
  );

  const multi = live.length > 1;
  // A run's page opens on the trigger it is a run of; otherwise the set.
  const defaultFocus = multi ? live.find((t) => isRunOf(t, conversationId, sessionId, agentTaskId)) : undefined;
  const focused = multi
    ? (focusedId && live.find((t) => t._id === focusedId)) || defaultFocus
    : live[0];
  const focusedIsLoop = !!focused && focused === loopRow;

  // Every run of the focused trigger, newest first (spawned runs and injected
  // turns alike). Loops have no run rows — the pseudo id must never reach the
  // query.
  const runs = useTriggerRuns(focused && !focusedIsLoop ? focused._id : null);

  if (live.length === 0) return null;

  const focus = (id: string | null) => {
    setFocusedId(id);
    setExpanded(true);
  };

  return (
    <div data-cc-context-panel className="border-b border-sol-border/30 bg-sol-bg-alt/20">
      {multi ? (
        <SetHeader
          live={live}
          focused={focused}
          expanded={expanded}
          now={now}
          onToggle={() => setExpanded((e) => !e)}
          onPill={(t) => {
            if (focused?._id === t._id) setExpanded((e) => !e);
            else focus(t._id);
          }}
          onShowAll={() => focus(null)}
        />
      ) : (
        <SingleHeader
          task={live[0]}
          isLoop={focusedIsLoop}
          expanded={expanded}
          now={now}
          conversationId={conversationId}
          sessionId={sessionId}
          agentTaskId={agentTaskId}
          onToggle={() => setExpanded((e) => !e)}
        />
      )}

      {/* Run history of the focused trigger: a connected dot rail — the next
          fire (when armed), a "now" tick, then every past run newest first.
          Outside the expander: browsing runs is the point of the strip on a
          run's page and shouldn't cost a click. Hidden when the only run is
          the one being viewed (a one-node rail says nothing the inline turn
          doesn't). */}
      {focused && runs && (runs.length > 1 || (runs.length === 1 && runs[0]._id !== conversationId)) && (
        <div data-cc-context-rail className="contents">
          <TriggerRunRail
            runs={runs}
            now={now}
            conversationId={conversationId}
            nextRunAt={focused.status === "scheduled" ? focused.run_at : undefined}
            className="px-4 pb-1.5 -mt-0.5"
          />
        </div>
      )}

      {expanded && (
        focused ? (
          // Keyed by trigger: every per-trigger transient (an armed "Confirm
          // cancel", an open prompt) dies when the focus moves, however it
          // moves, so a swap can never cancel the wrong trigger.
          <TriggerDetail
            key={focused._id}
            task={focused}
            isLoop={focusedIsLoop}
            now={now}
            runs={runs}
            conversationId={conversationId}
            sessionId={sessionId}
            agentTaskId={agentTaskId}
            setSize={multi ? live.length : 1}
            onShowAll={() => focus(null)}
          />
        ) : (
          <SetList live={live} loopRow={loopRow} now={now} conversationId={conversationId} onFocus={(t) => focus(t._id)} />
        )
      )}
    </div>
  );
}

// What the strip shows: every ARMED trigger (plus a live loop), in roster
// order. With nothing armed, fall back ONLY to a trigger this conversation is
// a RUN of — that provenance explains why the session exists, forever. A
// finished trigger on its home shows nothing: the injected turns already
// render inline, and a dead strip on a live session is noise.
export function liveTriggersFor(
  matched: TaskRow[],
  loopRow: TaskRow | null,
  conversationId: string,
  sessionId?: string | null,
  agentTaskId?: string | null,
): TaskRow[] {
  const armed = matched.filter((t) => ARMED_STATUSES.has(t.status)).sort(compareTriggerRoster);
  if (loopRow) armed.push(loopRow);
  if (armed.length > 0) return armed;
  const runOf = matched
    .filter((t) => isRunOf(t, conversationId, sessionId, agentTaskId))
    .sort((a, b) => (b.last_run_at ?? b.created_at) - (a.last_run_at ?? a.created_at))[0];
  return runOf ? [runOf] : [];
}

// The pills the collapsed set row draws: all of them up to MAX_PILLS, else
// the first few and a "+N" — and the focused trigger always keeps its pill.
export function pillsShown(live: TaskRow[], focused: TaskRow | undefined): TaskRow[] {
  const shown = live.length > MAX_PILLS ? live.slice(0, MAX_PILLS - 1) : live;
  return focused && !shown.includes(focused) ? [...shown.slice(0, -1), focused] : shown;
}

// -- Facts about one trigger relative to the conversation being viewed --

// True when the viewed conversation is a spawned RUN of the trigger. An inject
// trigger's runs land in its own home, which is the trigger's home, not a run.
function isRunOf(t: TaskRow, conversationId: string, sessionId?: string | null, agentTaskId?: string | null): boolean {
  return (
    t.originating_conversation_id !== conversationId &&
    ((!!agentTaskId && t._id === agentTaskId) ||
      t.last_run_conversation_id === conversationId ||
      (!!sessionId && t.last_run_session_uuid === sessionId))
  );
}

// Where a trigger came from: the stamped creator session, else the session it
// injects into (triggers that predate the created_by stamp, or whose creator
// detection failed — e.g. `cast trigger add` run through tmux, where process
// ancestry ends at the tmux server). Never the page being viewed.
function triggerProvenance(t: TaskRow, conversationId: string): { id?: string; title?: string } {
  const id =
    (t.created_by_conversation_id !== conversationId ? t.created_by_conversation_id : undefined) ??
    (t.originating_conversation_id !== conversationId ? t.originating_conversation_id : undefined);
  const title = id === t.created_by_conversation_id ? t.created_by_conversation_title : t.originating_conversation_title;
  return { id, title };
}

function ProvenanceChip({ id, title }: { id: string; title?: string }) {
  // A span, not a button: it sits inside the strip's <button> row, and nested
  // buttons are invalid HTML.
  return (
    <ShortcutTooltip label="Open the session that created this trigger">
      <span
        role="link"
        onClick={(e) => {
          e.stopPropagation();
          useInboxStore.getState().requestNavigate(id);
        }}
        className="inline-flex items-center gap-1 flex-shrink-0 max-w-[18rem] px-1.5 py-px rounded border border-sol-cyan/40 bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20 transition-colors"
      >
        <span className="truncate">from {title || "session"}</span>
        <ArrowUpRight className="w-3 h-3 flex-shrink-0" />
      </span>
    </ShortcutTooltip>
  );
}

function StatusWord({ task, now }: { task: TaskRow; now: number }) {
  switch (task.status) {
    case "scheduled": {
      if (task.run_at === undefined) return <span className="text-sol-orange">armed</span>;
      // taskStateLabel keeps the wording in lockstep with the inbox rows —
      // including the "due 12m" stuck-signal once a fire sits unclaimed.
      const label = taskStateLabel(task, now);
      return <span className="text-sol-orange tabular-nums">{task.run_at > now ? `next ${label}` : label}</span>;
    }
    case "running":
      return (
        <span className="flex items-center gap-1 text-sol-green">
          <LivePulseDot className="w-1.5 h-1.5" />
          running
        </span>
      );
    case "paused":
      return <span className="text-sol-text-dim">paused</span>;
    case "failed":
      return <span className="text-sol-red">failed</span>;
    default:
      return (
        <span className="text-sol-text-dim">
          done
          {task.last_run_at ? ` · ran ${fmtDuration(Math.max(0, now - task.last_run_at))} ago` : ""}
        </span>
      );
  }
}

const Tag = ({ children }: { children: ReactNode }) => (
  <span className="px-1 py-0 rounded bg-sol-orange/10 border border-sol-orange/30 text-sol-orange text-[9px] font-semibold flex-shrink-0">
    {children}
  </span>
);

// -- One trigger: the strip is that trigger --

export function SingleHeader({
  task,
  isLoop,
  expanded,
  now,
  conversationId,
  sessionId,
  agentTaskId,
  onToggle,
}: {
  task: TaskRow;
  isLoop: boolean;
  expanded: boolean;
  now: number;
  conversationId: string;
  sessionId?: string | null;
  agentTaskId?: string | null;
  onToggle: () => void;
}) {
  const router = useRouter();
  const isRun = isRunOf(task, conversationId, sessionId, agentTaskId);
  const provenance = triggerProvenance(task, conversationId);
  const triggerHref = isLoop ? null : `/triggers/${task.short_id ?? task._id}`;
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-sol-bg-alt/40 transition-colors"
    >
      <Clock className="w-3.5 h-3.5 text-sol-orange flex-shrink-0" />
      <ShortcutTooltip label={triggerHref ? "Open the trigger's page" : taskDisplayTitle(task)}>
        <span
          role={triggerHref ? "link" : undefined}
          onClick={
            triggerHref
              ? (e) => {
                  e.stopPropagation();
                  router.push(triggerHref);
                }
              : undefined
          }
          className={`font-medium text-sol-orange truncate ${triggerHref ? "hover:underline underline-offset-2" : ""}`}
        >
          {taskDisplayTitle(task)}
        </span>
      </ShortcutTooltip>
      {/* Health at a glance while collapsed: only bad outcomes earn a dot. */}
      <SchedHealthDot accent={schedAccent(task) === "running" ? "normal" : schedAccent(task)} task={task} />
      <span className="text-sol-text-dim flex-shrink-0">{isLoop ? "self-paced loop" : describeTaskCadence(task)}</span>
      {isRun && <Tag>run</Tag>}
      {isLoop && (
        <ShortcutTooltip label="The agent paces itself with scheduled wakeups (ScheduleWakeup)">
          <Tag>loop</Tag>
        </ShortcutTooltip>
      )}
      {/* Provenance: visible without expanding, since on a run's page "where
          did this come from" is the first question. The title truncates
          first; the way home never does. */}
      {provenance.id && <ProvenanceChip id={provenance.id} title={provenance.title} />}
      <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
        <StatusWord task={task} now={now} />
        {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim" />}
      </div>
    </button>
  );
}

// -- Several triggers: the strip is the set --

// The collapsed row: a count that opens the whole set, then one pill per
// trigger in roster order (soonest fire first). A pill focuses its trigger; the
// focused pill toggles the detail. The focused trigger always keeps its pill,
// even past the fold.
export function SetHeader({
  live,
  focused,
  expanded,
  now,
  onToggle,
  onPill,
  onShowAll,
}: {
  live: TaskRow[];
  focused: TaskRow | undefined;
  expanded: boolean;
  now: number;
  onToggle: () => void;
  onPill: (t: TaskRow) => void;
  onShowAll: () => void;
}) {
  const shown = pillsShown(live, focused);
  const folded = live.length - shown.length;
  const attention = live.filter((t) => schedAccent(t) === "attention").length;
  const showingAll = expanded && !focused;
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-4 py-1.5 text-xs cursor-pointer hover:bg-sol-bg-alt/40 transition-colors"
    >
      <ShortcutTooltip label="Show every trigger on this session">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (showingAll) onToggle();
            else onShowAll();
          }}
          className={`flex items-center gap-1.5 flex-shrink-0 rounded px-1 -mx-1 py-0.5 font-medium transition-colors ${
            showingAll ? "text-sol-orange bg-sol-orange/10" : "text-sol-orange hover:bg-sol-orange/10"
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span className="tabular-nums">{live.length} triggers</span>
          {attention > 0 && (
            <ShortcutTooltip label={`${attention} need${attention === 1 ? "s" : ""} attention`}>
              <span className="w-1.5 h-1.5 rounded-full bg-sol-red" />
            </ShortcutTooltip>
          )}
        </button>
      </ShortcutTooltip>
      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
        {shown.map((t) => (
          <TriggerPill key={t._id} task={t} now={now} active={focused?._id === t._id} onClick={() => onPill(t)} />
        ))}
        {folded > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onShowAll();
            }}
            className="flex-shrink-0 px-1.5 py-0.5 rounded-md text-[11px] tabular-nums text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60 transition-colors"
          >
            +{folded}
          </button>
        )}
      </div>
      <button
        aria-label={expanded ? "Collapse" : "Expand"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="flex-shrink-0 p-0.5 rounded text-sol-text-dim hover:text-sol-text"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
    </div>
  );
}

export function TriggerPill({ task, now, active, onClick }: { task: TaskRow; now: number; active: boolean; onClick: () => void }) {
  const accent = schedAccent(task);
  const alert = task.status === "failed" || isTaskOverdue(task, now);
  const title = taskDisplayTitle(task);
  return (
    <ShortcutTooltip label={title} hint={task.status === "scheduled" && task.run_at !== undefined ? `${describeTaskCadence(task)} · next at ${fmtClock(task.run_at)}` : describeTaskCadence(task)}>
      <button
        data-trigger-pill={task._id}
        aria-pressed={active}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={`group flex-1 basis-0 min-w-[5.5rem] max-w-max inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] transition-colors ${
          active
            ? "border-sol-orange/50 bg-sol-orange/10 text-sol-orange"
            : "border-sol-border/40 bg-sol-bg/40 text-sol-text-muted hover:border-sol-orange/40 hover:text-sol-text"
        } ${accent === "paused" ? "opacity-70" : ""}`}
      >
        <SchedHealthDot accent={accent} task={task} />
        <span className="truncate">{title}</span>
        <span
          className={`flex-shrink-0 tabular-nums ${
            alert ? "text-sol-red" : active ? "text-sol-orange/80" : "text-sol-text-dim"
          }`}
        >
          {taskStateLabel(task, now).replace(/^in /, "")}
        </span>
      </button>
    </ShortcutTooltip>
  );
}

// The expanded set with nothing focused: one row per trigger, enough to tell
// them apart (what, when, how it last went) — a click drills into one.
function SetList({
  live,
  loopRow,
  now,
  conversationId,
  onFocus,
}: {
  live: TaskRow[];
  loopRow: TaskRow | null;
  now: number;
  conversationId: string;
  onFocus: (t: TaskRow) => void;
}) {
  return (
    <div className="px-2 pb-2 text-xs animate-in fade-in slide-in-from-top-1 duration-150">
      <div className="space-y-px">
        {live.map((t) => {
          const isLoop = t === loopRow;
          const provenance = triggerProvenance(t, conversationId);
          const last = t.last_run_at;
          return (
            <button
              key={t._id}
              data-trigger-set-row={t._id}
              onClick={() => onFocus(t)}
              className="w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left hover:bg-sol-bg-alt/60 transition-colors"
            >
              <span className="mt-[3px] flex h-3 w-3 flex-shrink-0 items-center justify-center">
                {schedAccent(t) === "normal" || schedAccent(t) === "paused" ? (
                  <Clock className={`w-3 h-3 ${t.status === "paused" ? "text-sol-text-dim" : "text-sol-orange/80"}`} />
                ) : (
                  <SchedHealthDot accent={schedAccent(t)} task={t} />
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate font-medium text-sol-text">{taskDisplayTitle(t)}</span>
                  <span className="min-w-0 max-w-[40%] truncate text-[11px] text-sol-text-dim">
                    {isLoop ? "self-paced loop" : describeTaskCadence(t)}
                  </span>
                  {isLoop && <Tag>loop</Tag>}
                  {provenance.id && provenance.id !== conversationId && (
                    <span className="truncate text-[10px] text-sol-cyan/80">from {provenance.title || "session"}</span>
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-2 min-w-0 text-[11px] text-sol-text-dim">
                  <span className="truncate">{taskGist(t)}</span>
                  {last !== undefined && (
                    <span
                      className={`flex-shrink-0 inline-flex items-center gap-1 ${
                        t.last_run_failed ? "text-sol-red" : t.last_run_needs_attention ? "text-sol-orange" : ""
                      }`}
                    >
                      {t.last_run_failed ? (
                        <XCircle className="w-3 h-3" />
                      ) : t.last_run_needs_attention ? (
                        <AlertTriangle className="w-3 h-3" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3 text-sol-green/80" />
                      )}
                      {fmtDuration(Math.max(0, now - last))} ago
                    </span>
                  )}
                </span>
              </span>
              <SchedFireBadge task={t} className="flex-shrink-0 mt-px" />
            </button>
          );
        })}
      </div>
      <div className="flex justify-end px-2 pt-1">
        <Link href="/triggers" className="text-[10px] text-sol-cyan hover:underline">
          All triggers
        </Link>
      </div>
    </div>
  );
}

// -- One trigger's detail: briefing, prompt, cadence, last run, verbs --

function TriggerDetail({
  task: primary,
  isLoop,
  now,
  runs,
  conversationId,
  sessionId,
  agentTaskId,
  setSize,
  onShowAll,
}: {
  task: TaskRow;
  isLoop: boolean;
  now: number;
  runs: TriggerRun[] | undefined;
  conversationId: string;
  sessionId?: string | null;
  agentTaskId?: string | null;
  // How many live triggers the strip holds; above one, the detail carries the
  // way back to the set and the provenance the set header has no room for.
  setSize: number;
  onShowAll: () => void;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [lastRunOpen, setLastRunOpen] = useState(false);
  // Verbs are store actions (local-first): the row flips on the draft the
  // instant it's clicked and the dispatch side effect runs the real mutation.
  const triggerAction = useInboxStore((s) => s.triggerAction);
  const regenerateSummary = useMutation(api.agentTasks.webRegenerateSummary);
  // Fire-and-forget: the Haiku distillation lands through the roster
  // subscription, at which point the briefing swaps in and the button goes.
  const [summarizing, setSummarizing] = useState(false);

  const inSet = setSize > 1;
  const isRun = isRunOf(primary, conversationId, sessionId, agentTaskId);
  const provenance = triggerProvenance(primary, conversationId);
  const cadence = isLoop ? "self-paced loop" : describeTaskCadence(primary);
  const msUntil = primary.run_at !== undefined ? primary.run_at - now : undefined;
  // Verbs follow view access: anyone who can see the conversation can manage
  // its triggers, foreign or not (founder decision 2026-08-30). Loops carry
  // no server verbs at all.
  const canManage = !isLoop;
  // The dedicated trigger page (real triggers only — a loop's pseudo id
  // addresses nothing).
  const triggerHref = isLoop ? null : `/triggers/${primary.short_id ?? primary._id}`;

  const act = (verb: "pause" | "resume" | "runNow" | "cancel") => {
    triggerAction(primary._id, verb);
    setConfirmingCancel(false);
  };

  const copyPrompt = () => {
    copyToClipboard(primary.prompt).then(() => {
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1500);
    });
  };

  // Last-run outcome tone: the row's icon + wording follow the run's flags.
  const outcome = primary.last_run_failed
    ? { Icon: XCircle, tone: "text-sol-red", word: "failed" }
    : primary.last_run_needs_attention
      ? { Icon: AlertTriangle, tone: "text-sol-orange", word: "needs attention" }
      : { Icon: CheckCircle2, tone: "text-sol-green", word: null };

  const actionBtn =
    "px-2 py-1 rounded-md border text-[11px] font-medium transition-[color,background-color,transform] duration-100 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100";

  return (
    <div className="px-4 pb-3 space-y-2.5 text-xs animate-in fade-in slide-in-from-top-1 duration-150">
      {/* In a set, the pill only carries a short name: the detail opens on the
          full one, with the trigger's own status and where it came from. */}
      {inSet && (
        <div className="flex items-center gap-2 pt-1 min-w-0">
          <span className="font-medium text-[12px] text-sol-text truncate">{taskDisplayTitle(primary)}</span>
          {isRun && <Tag>run</Tag>}
          {isLoop && <Tag>loop</Tag>}
          {provenance.id && <ProvenanceChip id={provenance.id} title={provenance.title} />}
          <span className="ml-auto flex-shrink-0">
            <StatusWord task={primary} now={now} />
          </span>
        </div>
      )}

      {/* What this trigger does, in plain words (the Haiku-distilled
          display_summary). The raw prompt is the contract, not the briefing —
          it stays one click away below. The clamp keeps a missing summary
          (raw prompt fallback) from becoming a wall. */}
      {(() => {
        const brief = primary.display_summary?.trim() || primary.prompt;
        // Click-to-expand only when the clamp can actually bite (~3 lines
        // at this measure); a pointer cursor on short text is a dead click.
        const clampable = brief.length > 240;
        const para = (
          <p
            onClick={clampable ? () => setBriefOpen((s) => !s) : undefined}
            className={`max-w-[110ch] text-[12px] leading-relaxed text-sol-text ${
              clampable ? "cursor-pointer" : ""
            } ${briefOpen ? "" : "line-clamp-3"}`}
          >
            {brief}
          </p>
        );
        if (!clampable || briefOpen) return para;
        return <ShortcutTooltip label="Click to expand">{para}</ShortcutTooltip>;
      })()}

      <div className="flex items-center gap-3">
        <button
          onClick={() => setShowPrompt((s) => !s)}
          className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors"
        >
          {showPrompt ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {showPrompt ? "Hide full prompt" : "Show full prompt"}
        </button>
        {showPrompt && (
          <button
            onClick={copyPrompt}
            className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors"
          >
            {promptCopied ? <Check className="w-3 h-3 text-sol-green" /> : <Copy className="w-3 h-3" />}
            {promptCopied ? "Copied" : "Copy"}
          </button>
        )}
        {!primary.display_summary?.trim() && !isLoop && (
          <ShortcutTooltip label="Distill the prompt above into a short plain-words briefing">
            <button
              disabled={summarizing}
              onClick={() => {
                setSummarizing(true);
                regenerateSummary({ task_id: primary._id }).catch(() => setSummarizing(false));
              }}
              className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors disabled:opacity-60"
            >
              {summarizing ? "Summarizing…" : "Summarize"}
            </button>
          </ShortcutTooltip>
        )}
      </div>
      {/* Prompts are markdown (the CLI snippet asks agents to write them
          that way) — first-class rendering in a drag-resizable viewport.
          Copy still hands over the raw text. */}
      {showPrompt && <TriggerPromptView prompt={primary.prompt} className="-mx-4" />}

      <div className="flex items-center gap-3 flex-wrap text-[10px] text-sol-text-dim">
        <span className="inline-flex items-center gap-1.5">
          {cadence}
          {/* Where we are in the current cycle: fills as the next fire approaches. */}
          {primary.schedule_type === "recurring" &&
            primary.interval_ms !== undefined &&
            msUntil !== undefined && (
              <ShortcutTooltip label={`${Math.round(Math.min(1, Math.max(0, 1 - msUntil / primary.interval_ms)) * 100)}% through the ${fmtDuration(primary.interval_ms)} cycle`}>
                <span className="inline-block w-16 h-1 rounded-full bg-sol-bg-highlight overflow-hidden">
                  <span
                    className="block h-full rounded-full bg-sol-orange/70"
                    style={{
                      width: `${Math.round(Math.min(1, Math.max(0, 1 - msUntil / primary.interval_ms)) * 100)}%`,
                    }}
                  />
                </span>
              </ShortcutTooltip>
            )}
        </span>
        {primary.status === "scheduled" && primary.run_at !== undefined && (
          <ShortcutTooltip label={new Date(primary.run_at).toLocaleString()}>
            <span className="tabular-nums">next at {fmtClock(primary.run_at)}</span>
          </ShortcutTooltip>
        )}
        {/* Apply is the norm and unmarked; read-only is the exception worth a chip. */}
        {primary.mode !== "apply" && (
          <ShortcutTooltip label="Read-only run — investigates and reports, changes nothing" hint="file-editing tools are disabled">
            <span className="px-1.5 py-px rounded border font-medium border-sol-cyan/40 text-sol-cyan/90 bg-sol-cyan/10">
              read-only
            </span>
          </ShortcutTooltip>
        )}
      </div>

      {(primary.last_run_at || primary.last_run_summary) && (
        <div
          className={`rounded border border-sol-border/30 border-l-2 bg-sol-bg/40 px-2.5 py-2 space-y-1 ${
            primary.last_run_failed
              ? "border-l-sol-red/60"
              : primary.last_run_needs_attention
                ? "border-l-sol-orange/60"
                : "border-l-sol-green/50"
          }`}
        >
          <div className="flex items-center gap-1.5 text-[10px]">
            <outcome.Icon className={`w-3 h-3 flex-shrink-0 ${outcome.tone}`} />
            <span className="font-semibold uppercase tracking-wider text-sol-text-dim/70">
              {isLoop ? "Last wakeup" : "Last run"}
            </span>
            {primary.last_run_at && (
              <ShortcutTooltip label={new Date(primary.last_run_at).toLocaleString()}>
                <span className="text-sol-text-dim tabular-nums">
                  {fmtDuration(Math.max(0, now - primary.last_run_at))} ago
                </span>
              </ShortcutTooltip>
            )}
            {outcome.word && <span className={`font-medium ${outcome.tone}`}>{outcome.word}</span>}
            {/* Manual re-runs create run conversations without bumping
                run_count — trust the larger of the two, and stay silent
                when the rail above already states the count. */}
            {(() => {
              const total = Math.max(primary.run_count, runs?.length ?? 0);
              if (total === 0 || (runs?.length ?? 0) > 1) return null;
              return (
                <span className="text-sol-text-dim/70">
                  · {total} run{total === 1 ? "" : "s"} total
                </span>
              );
            })()}
            {primary.last_run_conversation_id && primary.last_run_conversation_id !== conversationId && (
              <button
                onClick={() => useInboxStore.getState().requestNavigate(primary.last_run_conversation_id!)}
                className="ml-auto inline-flex items-center gap-0.5 text-sol-cyan hover:underline"
              >
                Open run <ArrowUpRight className="w-3 h-3" />
              </button>
            )}
          </div>
          {primary.last_run_summary && (() => {
            const clampable = primary.last_run_summary.length > 160;
            const para = (
              <p
                onClick={clampable ? () => setLastRunOpen((s) => !s) : undefined}
                className={`max-w-[110ch] text-[11px] leading-relaxed text-sol-text-muted transition-colors ${
                  clampable ? "cursor-pointer hover:text-sol-text" : ""
                } ${lastRunOpen ? "" : "line-clamp-2"}`}
              >
                {primary.last_run_summary}
              </p>
            );
            if (!clampable) return para;
            return <ShortcutTooltip label={lastRunOpen ? "Click to collapse" : "Click to expand"}>{para}</ShortcutTooltip>;
          })()}
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-0.5 flex-wrap">
        {!isLoop && primary.is_own === false && primary.owner_name && (
          <ShortcutTooltip label="This trigger runs under a different account; anyone who can see it can manage it">
            <span className="px-1.5 py-px rounded border border-sol-border/50 text-[10px] text-sol-text-dim">
              runs as {primary.owner_name}
            </span>
          </ShortcutTooltip>
        )}
        {canManage && ARMED_STATUSES.has(primary.status) && (
          <>
            <ShortcutTooltip label="Queue a run immediately — doesn't shift the regular cadence">
              <button
                onClick={() => act("runNow")}
                className={`${actionBtn} border-sol-cyan/40 text-sol-cyan bg-sol-cyan/10 hover:bg-sol-cyan/20`}
              >
                <span className="inline-flex items-center gap-1">
                  <Play className="w-3 h-3" /> Run now
                </span>
              </button>
            </ShortcutTooltip>
            {primary.status === "paused" ? (
              <ShortcutTooltip label="Re-arm the trigger — fires resume from now">
                <button
                  onClick={() => act("resume")}
                  className={`${actionBtn} border-sol-orange/40 text-sol-orange hover:bg-sol-orange/10`}
                >
                  <span className="inline-flex items-center gap-1">
                    <Play className="w-3 h-3" /> Resume
                  </span>
                </button>
              </ShortcutTooltip>
            ) : (
              <ShortcutTooltip label="Pause — skips every fire until resumed">
                <button
                  onClick={() => act("pause")}
                  className={`${actionBtn} border-sol-border/50 text-sol-text-dim hover:bg-sol-bg-alt/60`}
                >
                  <span className="inline-flex items-center gap-1">
                    <Pause className="w-3 h-3" /> Pause
                  </span>
                </button>
              </ShortcutTooltip>
            )}
            {confirmingCancel ? (
              <ShortcutTooltip label="Really cancel — this trigger won't fire again">
                <button
                  onClick={() => act("cancel")}
                  className={`${actionBtn} border-sol-red/50 text-sol-red bg-sol-red/10 hover:bg-sol-red/20`}
                >
                  Confirm cancel
                </button>
              </ShortcutTooltip>
            ) : (
              <ShortcutTooltip label="Cancel this trigger permanently" hint="asks to confirm">
                <button
                  onClick={() => setConfirmingCancel(true)}
                  className={`${actionBtn} border-sol-border/50 text-sol-text-dim hover:text-sol-red hover:border-sol-red/40`}
                >
                  <span className="inline-flex items-center gap-1">
                    <X className="w-3 h-3" /> Cancel
                  </span>
                </button>
              </ShortcutTooltip>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-3">
          {inSet && (
            <button
              onClick={onShowAll}
              className="inline-flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors"
            >
              <ArrowLeft className="w-3 h-3" /> All {setSize} triggers
            </button>
          )}
          {triggerHref && (
            <Link href={triggerHref} className="text-[10px] text-sol-cyan hover:underline">
              Open trigger page
            </Link>
          )}
          <Link href="/triggers" className="text-[10px] text-sol-cyan hover:underline">
            All triggers
          </Link>
        </span>
      </div>

      {/* The triage-verb contract, stated where the user decides. Stash vs
          dismiss/kill do different things to a trigger and nothing else in
          the UI says so at the moment of choice. */}
      {ARMED_STATUSES.has(primary.status) && (
        <p className="text-[10px] leading-relaxed text-sol-text-dim/80 border-t border-sol-border/20 pt-1.5">
          {isLoop ? (
            <>
              The agent set its own wakeup and controls this loop from inside the session — message it to steer or stop it.{" "}
              <span className="text-sol-text-dim font-medium">Stash</span> keeps it looping quietly out of your queue;{" "}
              <span className="text-sol-text-dim font-medium">dismiss/kill</span> tears the session — and its loop — down.
            </>
          ) : primary.originating_conversation_id === conversationId ? (
            <>
              <span className="text-sol-text-dim font-medium">Stash</span> keeps this session running quietly — the trigger still fires here, out of your queue.{" "}
              <span className="text-sol-text-dim font-medium">Dismiss/kill</span> retires the session and cancels this trigger.
            </>
          ) : isRun ? (
            <>
              Dismissing this run leaves the trigger armed — the next run replaces it.{" "}
              <span className="text-sol-text-dim font-medium">Cancel</span> above stops future runs.
            </>
          ) : (
            <>
              <span className="text-sol-text-dim font-medium">Stash</span> keeps the target session running quietly.{" "}
              <span className="text-sol-text-dim font-medium">Dismiss/kill</span> on it cancels this trigger.
            </>
          )}
        </p>
      )}
    </div>
  );
}
