"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { AuthGuard } from "../../components/AuthGuard";
import { AppLoader } from "../../components/AppLoader";
import { DashboardLayout } from "../../components/DashboardLayout";
import { fmtDuration, fmtClock } from "../../components/triggerCadence";
// The `--on <event>` vocabulary is shared with the CLI so the two cannot drift.
import {
  TRIGGER_EVENT_SHORTHANDS,
  TRIGGER_EVENT_NAMES,
  TRIGGER_EVENT_LABELS,
  triggerEventShorthand,
} from "@codecast/shared/contracts";
import { ShortcutTooltip } from "../../components/KeyboardShortcutsHelp";
import { isTriggerFailing, taskDisplayTitle, groupTriggerRowsByHome, type TaskRow, type TriggerRow, type TriggerHomeGroup } from "../../components/triggerTasks";
import { TriggerRowItem, TriggerHomeHeader } from "../../components/TriggerRow";
import { useTriggers, fetchTriggerRuns } from "../../hooks/useSyncTriggers";
import { openRunInStore } from "../../components/TriggerRunHistory";
import { SelectBox } from "../../components/ui/select-box";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { useInboxStore, filterInboxScopeFromState } from "../../store/inboxStore";
import {
  Clock,
  Plus,
  Zap,
  Repeat,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Search,
  ListFilter,
  Pencil,
  X,
} from "lucide-react";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
const api = _api as any;

// ── Time helpers (parseDuration is a parity port of `cast trigger add --in/--every`) ──

function parseDuration(input: string): number | undefined {
  const match = input.toLowerCase().trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/);
  if (!match) return undefined;
  const num = parseInt(match[1]);
  const unit = match[2][0];
  if (unit === "s") return num * 1000;
  if (unit === "m") return num * 60 * 1000;
  if (unit === "h") return num * 60 * 60 * 1000;
  if (unit === "d") return num * 24 * 60 * 60 * 1000;
  return undefined;
}

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}


function projectName(path?: string): string {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() || path;
}

// ── Horizon rail: past 24h of runs and next 24h of fires on one time axis ──

const HORIZON_MS = 24 * 3600_000; // each direction from "now"

interface RailPoint {
  pct: number; // 0..1 along the rail; 0 = -24h, 0.5 = now, 1 = +24h
  task: any;
  at: number;
  kind: "running" | "due" | "next" | "ghost" | "past";
  lane: number; // 0 center, 1 above, 2 below — declusters near-coincident dots
}

const railPct = (at: number, now: number) => 0.5 + (at - now) / (2 * HORIZON_MS);

function collectRailPoints(tasks: any[], now: number): RailPoint[] {
  const points: RailPoint[] = [];
  for (const t of tasks) {
    // Past half: each task's latest run — complete coverage for daily cadences;
    // a faster loop shows its newest run. Includes finished one-times.
    if (t.last_run_at && t.last_run_at > now - HORIZON_MS && t.last_run_at <= now) {
      points.push({ pct: railPct(t.last_run_at, now), task: t, at: t.last_run_at, kind: "past", lane: 0 });
    }
    if (t.status === "running") {
      points.push({ pct: 0.5, task: t, at: now, kind: "running", lane: 0 });
      continue;
    }
    if (t.status !== "scheduled" || !t.run_at) continue;
    const dt = t.run_at - now;
    if (dt <= 0) {
      points.push({ pct: 0.5, task: t, at: now, kind: "due", lane: 0 });
    } else if (dt <= HORIZON_MS) {
      points.push({ pct: railPct(t.run_at, now), task: t, at: t.run_at, kind: "next", lane: 0 });
    }
    // Project recurring tasks forward so the rail shows the day's cadence.
    if (t.schedule_type === "recurring" && t.interval_ms) {
      const first = Math.max(dt, 0);
      for (let at = first + t.interval_ms; at <= HORIZON_MS; at += t.interval_ms) {
        points.push({ pct: railPct(now + at, now), task: t, at: now + at, kind: "ghost", lane: 0 });
        if (points.length > 200) break; // sanity cap for tiny intervals
      }
    }
  }
  // Daily tasks created minutes apart land on the same pixel and would hide
  // each other from hover/click — fan near-coincident real dots across lanes.
  const real = points.filter((p) => p.kind !== "ghost").sort((a, b) => a.pct - b.pct);
  for (let i = 1; i < real.length; i++) {
    if (real[i].pct - real[i - 1].pct < 0.012) real[i].lane = (real[i - 1].lane + 1) % 3;
  }
  return points;
}

// Open a task's latest run at the message that triggered it. The precise target
// comes from a one-shot webListRuns fetch on click (an always-visible surface
// can't afford a standing subscription per task), then it rides the same store
// deep-link channel as the run-history list. Falls back to just opening the
// run's conversation when the history can't be enumerated.
//
// Shared by every surface that points at a run — the rail's dots and the failure
// banner — so "show me what happened" behaves the same wherever it's offered.
function useOpenLatestRun() {
  const router = useRouter();
  const convex = useConvex();
  return useCallback(async (task: any) => {
    try {
      const runs = await fetchTriggerRuns(convex, task._id);
      const run = runs?.[0]; // newest first — the dot is the latest run
      if (run) {
        openRunInStore(run);
        router.push(`/inbox?s=${run._id}`);
        return;
      }
    } catch {
      // fall through to the coarse target
    }
    if (task.last_run_conversation_id) {
      useInboxStore.getState().requestNavigate(task.last_run_conversation_id);
      router.push(`/inbox?s=${task.last_run_conversation_id}`);
    }
  }, [convex, router]);
}

function HorizonRail({ tasks, now }: { tasks: any[]; now: number }) {
  const points = useMemo(() => collectRailPoints(tasks, now), [tasks, now]);
  const openPastRun = useOpenLatestRun();

  if (points.length === 0) return null;

  return (
    // Flat on the page: the baseline is the only line, the ends land on the
    // column edges, and the row chips (violet loops, cyan one-shots) already
    // teach the colors, so there is no legend and no box.
    <div className="mt-2 select-none">
      <div className="relative h-12">
        {/* baseline — the past half sits dimmer */}
        <div className="absolute left-0 right-1/2 top-1/2 h-px bg-sol-border/60" />
        <div className="absolute left-1/2 right-0 top-1/2 h-px bg-sol-border" />
        {/* 12h ticks */}
        {[0.25, 0.75].map((p) => (
          <div key={p} className="absolute top-1/2 -translate-y-1/2 h-2.5 w-px bg-sol-border" style={{ left: `${p * 100}%` }} />
        ))}
        {/* now marker — a full-height cyan line so "the present" reads instantly */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-sol-cyan/50" />
        <div className="absolute left-1/2 top-0 w-1 h-1 -translate-x-1/2 rounded-full bg-sol-cyan" />
        {/* dots */}
        {points.map((pt, i) => {
          const base = pt.task.schedule_type === "recurring" ? "bg-sol-violet" : "bg-sol-cyan";
          const failed = pt.kind === "past" && (isTriggerFailing(pt.task) || pt.task.status === "failed");
          const cls =
            pt.kind === "ghost"
              ? `${base} opacity-25 w-1.5 h-1.5`
              : pt.kind === "past"
                ? `${failed ? "bg-sol-red" : base} opacity-60 group-hover:opacity-100 w-2 h-2`
                : pt.kind === "running"
                  ? "bg-emerald-400 animate-pulse w-2.5 h-2.5"
                  : pt.kind === "due"
                    ? `${base} animate-pulse w-2.5 h-2.5`
                    : `${base} w-2 h-2`;
          const label =
            pt.kind === "running"
              ? "running now"
              : pt.kind === "due"
                ? "due now"
                : pt.kind === "past"
                  ? `${failed ? "failed" : "ran"} ${timeAgo(pt.at)} — open run`
                  : fmtClock(pt.at);
          const dy = pt.lane === 1 ? -6 : pt.lane === 2 ? 6 : 0;
          const style = { left: `${Math.min(Math.max(pt.pct, 0), 1) * 100}%`, marginTop: dy };
          const inner = (
            <>
              <div className={`rounded-full ${cls} group-hover:scale-150 transition-transform`} />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 whitespace-nowrap rounded-md border border-sol-border bg-sol-bg-highlight px-2 py-1 text-[11px] text-sol-text shadow-lg pointer-events-none">
                <span className="font-medium">{taskDisplayTitle(pt.task)}</span>
                <span className="text-sol-text-dim"> · {label}</span>
              </div>
            </>
          );
          return pt.kind === "past" ? (
            <button
              key={`${pt.task._id}-${i}`}
              onClick={() => openPastRun(pt.task)}
              aria-label={`Open run: ${taskDisplayTitle(pt.task)}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group cursor-pointer p-1.5 -m-1.5"
              style={style}
            >
              {inner}
            </button>
          ) : (
            <div
              key={`${pt.task._id}-${i}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group"
              style={style}
            >
              {inner}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-sol-text-dim font-mono mt-1">
        <span>-24h</span><span>-12h</span><span>now</span><span>+12h</span><span>+24h</span>
      </div>
    </div>
  );
}

// ── Schedule composer (create / edit / duplicate) ──

type SchedKind = "now" | "in" | "every" | "on";

// interval_ms / delay back to a token parseDuration understands ("90m" if not a
// clean hour/day boundary, else "2h" / "3d").
function msToDurationToken(ms: number): string {
  const mins = Math.max(Math.round(ms / 60_000), 1);
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function deriveInitial(t: any | undefined) {
  if (!t) {
    // Human-created schedules default to apply: you wrote the prompt, it just
    // does the task. Read-only is the marked exception (the checkbox below).
    // Agent-created schedules (cast trigger add) still default to propose —
    // their prompts were never reviewed by a person.
    return { prompt: "", title: "", kind: "in" as SchedKind, duration: "30m", eventKey: "pr_comment", mode: "apply" as const, agent: "claude" as const, project: "" };
  }
  let kind: SchedKind = "in";
  let duration = "30m";
  let eventKey = "pr_comment";
  if (t.schedule_type === "recurring" && t.interval_ms) {
    kind = "every";
    duration = msToDurationToken(t.interval_ms);
  } else if (t.schedule_type === "event") {
    kind = "on";
    // A filter nothing names reads back as its raw pair, which is not one of
    // the options, so fall back to a real key rather than blanking the select.
    const named = triggerEventShorthand(t.event_filter ?? undefined);
    eventKey = named && TRIGGER_EVENT_SHORTHANDS[named] ? named : "pr_comment";
  } else if (t.schedule_type === "once" && t.run_at) {
    kind = "in";
    duration = msToDurationToken(Math.max(t.run_at - Date.now(), 60_000));
  }
  return {
    prompt: t.prompt ?? "",
    title: t.title ?? "",
    kind,
    duration,
    eventKey,
    mode: (t.mode === "apply" ? "apply" : "propose") as "propose" | "apply",
    agent: (t.agent_type === "codex" ? "codex" : "claude") as "claude" | "codex",
    project: t.project_path ?? "",
  };
}

function TriggerForm({ onClose, editTask, seedTask, embedded }: {
  onClose: () => void;
  editTask?: any;
  seedTask?: any;
  embedded?: boolean;
}) {
  const isEdit = !!editTask;
  const init = useMemo(() => deriveInitial(editTask ?? seedTask), [editTask, seedTask]);
  const create = useMutation(api.agentTasks.webCreate);
  const updateTask = useMutation(api.agentTasks.webUpdate);
  const [prompt, setPrompt] = useState(init.prompt);
  const [title, setTitle] = useState(init.title);
  const [kind, setKind] = useState<SchedKind>(init.kind);
  const [duration, setDuration] = useState(init.duration);
  const [eventKey, setEventKey] = useState(init.eventKey);
  const [mode, setMode] = useState<"propose" | "apply">(init.mode);
  const [agent, setAgent] = useState<"claude" | "codex">(init.agent);
  const [project, setProject] = useState(init.project);
  const [submitting, setSubmitting] = useState(false);

  // Suggest project paths from sessions already in the store — same data the
  // sidebar's workspace list derives from, without re-running its grouping.
  const sessions = useInboxStore((s) => s.sessions);
  const projectOptions = useMemo(() => {
    const seen = new Map<string, number>();
    // Scoped enumeration: cached sessions from other scopes/teams must not
    // leak their project paths into this workspace's suggestions.
    for (const s of Object.values(filterInboxScopeFromState(useInboxStore.getState()))) {
      const p = (s as any)?.project_path;
      if (!p) continue;
      const u = (s as any)?.updated_at ?? 0;
      if ((seen.get(p) ?? 0) < u) seen.set(p, u);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 12);
  }, [sessions]);

  const parsed = parseDuration(duration);
  const needsDuration = kind === "in" || kind === "every";
  const valid = prompt.trim().length > 0 && (!needsDuration || parsed !== undefined);

  const preview = !needsDuration
    ? null
    : parsed === undefined
      ? "format: 30m, 2h, 1d"
      : kind === "in"
        ? `runs at ${fmtClock(Date.now() + parsed)}`
        : `every ${fmtDuration(parsed)}, first run ${fmtClock(Date.now() + parsed)}`;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const args: any = {
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        mode,
        agent_type: agent,
        project_path: isEdit ? project.trim() : project.trim() || undefined,
      };
      if (kind === "on") {
        args.schedule_type = "event";
        args.event_filter = TRIGGER_EVENT_SHORTHANDS[eventKey];
      } else if (kind === "every") {
        args.schedule_type = "recurring";
        args.interval_ms = parsed;
        args.run_at = Date.now() + parsed!;
      } else {
        args.schedule_type = "once";
        args.run_at = kind === "in" ? Date.now() + parsed! : Date.now();
      }
      if (isEdit) {
        const ok = await updateTask({ task_id: editTask._id, ...args });
        if (ok === false) { toast.error("Can't edit — it may be running or finished"); return; }
        toast.success("Saved");
      } else {
        await create(args);
        toast.success(kind === "now" ? "Queued — runs within ~30s" : "Trigger set");
      }
      onClose();
    } catch {
      toast.error(isEdit ? "Failed to save" : "Failed to set trigger");
    } finally {
      setSubmitting(false);
    }
  };

  // A labeled row on a hairline: label in a fixed column, the control bare
  // beside it. The rule under each row is the control's line; it turns cyan
  // while the row holds focus. Same grammar as the settings kit's rows.
  const Row = ({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) => (
    <div className={`flex items-start gap-4 border-b border-sol-border/40 focus-within:border-sol-cyan/70 transition-colors ${className}`}>
      <span className="w-14 flex-shrink-0 pt-2 text-[10px] uppercase tracking-widest text-sol-text-dim select-none">{label}</span>
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-4 gap-y-1">{children}</div>
    </div>
  );
  const bareInput =
    "bg-transparent py-2 text-xs text-sol-text placeholder:text-sol-text-dim focus:outline-none";

  return (
    // Standalone: a band between hairlines on the page. Embedded: sits under
    // the row's own divider. Either way, nothing inside draws a box; the
    // primary button is the page's one fill.
    <div className={embedded ? "pt-1" : "border-t border-sol-border/40 pt-1 mb-6"}>
      {isEdit && (
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-sol-cyan pt-2 pb-1">
          <Pencil className="w-3 h-3" /> Editing trigger
        </div>
      )}
      <Row label="Prompt">
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            if (e.key === "Escape") onClose();
          }}
          placeholder='What should the agent do? e.g. "Check if CI is green on main and report"'
          rows={3}
          className={`w-full ${bareInput} text-sm leading-relaxed resize-none`}
        />
      </Row>
      <Row label="Title">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Optional — auto-named from the prompt"
          className={`w-full ${bareInput}`}
        />
      </Row>
      <Row label="When">
        <SegmentedToggle
          variant="bare"
          value={kind}
          onChange={(k) => setKind(k as SchedKind)}
          items={[
            { key: "now", label: "now" },
            { key: "in", label: "in…" },
            { key: "every", label: "every…" },
            { key: "on", label: "on event" },
          ]}
        />
        {needsDuration && (
          <span className="inline-flex items-center gap-2">
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              aria-invalid={parsed === undefined}
              className={`w-14 ${bareInput} font-mono border-b ${
                parsed === undefined ? "border-sol-red text-sol-red" : "border-sol-border/60 focus:border-sol-cyan"
              }`}
            />
            <span className={`text-[11px] ${parsed === undefined ? "text-sol-red" : "text-sol-text-dim"}`}>{preview}</span>
          </span>
        )}
        {kind === "on" && (
          <SelectBox variant="bare" value={eventKey} onChange={(e) => setEventKey(e.target.value)}>
            {TRIGGER_EVENT_NAMES.map((k) => (
              <option key={k} value={k}>{TRIGGER_EVENT_LABELS[k] ?? k}</option>
            ))}
          </SelectBox>
        )}
      </Row>
      <Row label="Agent">
        <SegmentedToggle
          variant="bare"
          value={agent}
          onChange={(a) => setAgent(a as "claude" | "codex")}
          items={[
            { key: "claude", label: "claude" },
            { key: "codex", label: "codex" },
          ]}
        />
        <label className="inline-flex items-center gap-1.5 py-1 text-xs text-sol-text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={mode === "propose"}
            onChange={(e) => setMode(e.target.checked ? "propose" : "apply")}
            className="accent-sol-cyan"
          />
          read-only — report, don&apos;t change anything
        </label>
      </Row>
      <Row label="Project">
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          list="trigger-project-roots"
          placeholder="Optional path"
          className={`w-full ${bareInput} font-mono`}
        />
        <datalist id="trigger-project-roots">
          {projectOptions.map((p) => <option key={p} value={p} />)}
        </datalist>
      </Row>

      <div className="flex items-center justify-between pt-3 pb-1">
        <span className="text-[11px] text-sol-text-dim">Runs on your daemon — it polls every 30s</span>
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="text-xs text-sol-text-dim hover:text-sol-text transition-colors">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid || submitting}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isEdit
              ? submitting ? "Saving…" : "Save changes"
              : submitting ? "Setting…" : "Set trigger"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──

function Section({ title, count, subtitle, children, defaultOpen = true }: {
  title: string;
  count: number;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-sol-text-dim hover:text-sol-text-muted transition-colors mb-2 select-none w-full"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
        <span className="text-sol-text-dim/70 normal-case tracking-normal font-mono">{count}</span>
        {subtitle && (
          <span className="text-sol-text-dim/60 normal-case tracking-normal font-normal ml-1">· {subtitle}</span>
        )}
      </button>
      {open && <div className="flex flex-col border-t border-sol-border/40">{children}</div>}
    </div>
  );
}

// ── Aggregate health stats across all tasks ──

interface SchedStats {
  active: number;
  // The primary split: standing loops vs one-shot runs. Event schedules join
  // neither count (they have their own filter) but are part of `active`.
  recurring: number;
  oneTime: number;
  totalRuns: number;
  // Active triggers whose LAST run failed — i.e. actually in trouble right now.
  // Keyed on last_run_failed, never on retry_count: that counter is the current
  // streak and a recovered trigger keeps its history, so counting it here made
  // one old blip read as "retrying" forever (the rail, which already keys on
  // last_run_failed, disagreed with the banner and the rail was right).
  failing: number;
  nextRunAt: number | null; // soonest upcoming scheduled run
  running: number;
}

function computeStats(all: any[], now: number): SchedStats {
  let active = 0, recurring = 0, oneTime = 0, totalRuns = 0, failing = 0, running = 0;
  let nextRunAt: number | null = null;
  for (const t of all) {
    totalRuns += t.run_count ?? 0;
    const isActive = t.status === "scheduled" || t.status === "running";
    if (isActive) {
      active++;
      if (t.schedule_type === "once") oneTime++;
      else if (t.schedule_type === "recurring") recurring++;
      if (t.status === "running") running++;
      if (isTriggerFailing(t)) failing++;
      if (t.status === "scheduled" && t.run_at && t.run_at > now) {
        if (nextRunAt === null || t.run_at < nextRunAt) nextRunAt = t.run_at;
      }
    }
  }
  return { active, recurring, oneTime, totalRuns, failing, nextRunAt, running };
}

// The overview is one sentence under the title, not a strip of tiles: every
// number here is also said by a section header, a filter pill or a row label,
// so it earns only a line. The clickable parts are the same toggles the filter
// pills drive (type, failing); the rest is plain text.
function OverviewLine({ stats, now, filters, update }: {
  stats: SchedStats;
  now: number;
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
}) {
  const sep = <span className="text-sol-text-dim/60">·</span>;
  const num = "tabular-nums font-medium text-sol-text";
  const toggle = (on: boolean, accent: string) =>
    `inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors ${
      on ? `${accent} bg-sol-bg-highlight` : "hover:text-sol-text"
    }`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sol-text-muted">
      <span><span className={num}>{stats.active}</span> active</span>
      {sep}
      <ShortcutTooltip label="Standing triggers that fire on an interval — click to filter">
        <button
          onClick={() => update({ type: filters.type === "recurring" ? "all" : "recurring" })}
          className={toggle(filters.type === "recurring", "text-sol-violet")}
        >
          <span className={num}>{stats.recurring}</span> recurring
        </button>
      </ShortcutTooltip>
      {sep}
      <ShortcutTooltip label="Triggers that fire once and finish — click to filter">
        <button
          onClick={() => update({ type: filters.type === "once" ? "all" : "once" })}
          className={toggle(filters.type === "once", "text-sol-cyan")}
        >
          <span className={num}>{stats.oneTime}</span> one-time
        </button>
      </ShortcutTooltip>
      {stats.running > 0 ? (
        <>
          {sep}
          <span className="text-emerald-400">
            <span className="tabular-nums font-medium">{stats.running}</span> running now
          </span>
        </>
      ) : stats.nextRunAt ? (
        <>
          {sep}
          <span className="text-sol-cyan">next in <span className="tabular-nums font-medium">{fmtDuration(Math.max(stats.nextRunAt - now, 0))}</span></span>
        </>
      ) : null}
      {sep}
      {stats.failing > 0 ? (
        <ShortcutTooltip label="Triggers whose last run failed — click to filter">
          <button
            onClick={() => update({ failing: !filters.failing })}
            className={toggle(filters.failing, "text-sol-red")}
          >
            <AlertTriangle className="w-3 h-3 text-sol-red" />
            <span className={`${num} text-sol-red`}>{stats.failing}</span>
            <span className="text-sol-red">failed last run</span>
          </button>
        </ShortcutTooltip>
      ) : (
        <span className="inline-flex items-center gap-1 text-emerald-400">
          <CheckCircle2 className="w-3 h-3" /> healthy
        </span>
      )}
    </div>
  );
}

// Every trigger listed here is a button: the point of telling someone a run
// failed is to hand them the run. Each row opens the failed run itself — the
// same target the rail's red dot uses — so the error is one click from what
// went wrong, not a dead-end notice.
function AttentionBanner({ tasks }: { tasks: any[] }) {
  const openRun = useOpenLatestRun();
  if (tasks.length === 0) return null;
  const plural = tasks.length === 1;
  // The count already sits in the overview line; this band carries the names.
  // Grounded: a left bar on the column edge and a tint, no rounded island.
  return (
    <div className="flex items-start gap-2.5 border-l-2 border-sol-red bg-sol-red/[0.06] pl-3 pr-3 py-2 mt-3">
      <div className="min-w-0 text-xs flex-1">
        <span className="text-sol-red font-medium">
          Failed on {plural ? "its" : "their"} last run
        </span>
        <div className="mt-0.5 flex flex-col items-start gap-0.5">
          {tasks.slice(0, 3).map((t) => (
            <button
              key={t._id}
              onClick={() => openRun(t)}
              aria-label={`Open failed run: ${taskDisplayTitle(t)}`}
              className="group max-w-full truncate text-left rounded -mx-1 px-1 py-0.5 text-sol-text-dim hover:bg-sol-red/10 hover:text-sol-text transition-colors cursor-pointer"
            >
              <span className="text-sol-text-muted group-hover:text-sol-text underline decoration-dotted decoration-sol-text-dim/50 underline-offset-2">
                {taskDisplayTitle(t)}
              </span>
              {t.retry_count > 0 && ` — retry ${t.retry_count}`}
              {t.last_run_summary ? ` · ${t.last_run_summary.replace(/^Failed:?\s*/, "")}` : ""}
            </button>
          ))}
          {tasks.length > 3 && (
            <span className="text-sol-text-dim px-1">+{tasks.length - 3} more</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Filtering ──

interface Filters {
  search: string;
  mode: string; // all | apply | propose
  type: string; // all | recurring | once | event
  project: string; // all | <path>
  agent: string; // all | claude | codex
  failing: boolean; // only triggers whose last run failed
}

const EMPTY_FILTERS: Filters = { search: "", mode: "all", type: "all", project: "all", agent: "all", failing: false };

function filtersActive(f: Filters): boolean {
  return f.search.trim() !== "" || f.mode !== "all" || f.type !== "all" || f.project !== "all" || f.agent !== "all" || f.failing;
}

function matchesFilters(t: any, f: Filters): boolean {
  if (f.failing && !isTriggerFailing(t)) return false;
  if (f.mode !== "all" && (t.mode ?? "propose") !== f.mode) return false;
  if (f.type !== "all" && t.schedule_type !== f.type) return false;
  if (f.agent !== "all" && (t.agent_type || "claude") !== f.agent) return false;
  if (f.project !== "all" && t.project_path !== f.project) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${t.title ?? ""} ${t.display_title ?? ""} ${t.display_summary ?? ""} ${t.prompt ?? ""} ${t.last_run_summary ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// The type filter is text that takes its cadence color when on (violet loops,
// cyan one-shots, yellow event hooks) — click filters, click again clears.
// Same toggle the overview line's recurring/one-time words drive.
const TYPE_TOGGLES: { key: string; label: string; Icon: any; on: string }[] = [
  { key: "recurring", label: "recurring", Icon: Repeat, on: "text-sol-violet" },
  { key: "once", label: "one-time", Icon: Clock, on: "text-sol-cyan" },
  { key: "event", label: "event", Icon: Zap, on: "text-sol-yellow" },
];

// Palette grammar: the search is bare text on a hairline that turns cyan on
// focus, and every filter beneath it is text — toggles that take color when
// on, selects as value plus chevron, a ghost icon for grouping. No control
// draws its own box; the bar's rules are the only lines.
type Grouping = "session" | "project" | "none";

function FilterBar({ filters, update, projects, hasCodex, hasEvent, shown, total, grouping, setGrouping }: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  projects: string[];
  hasCodex: boolean;
  hasEvent: boolean;
  shown: number;
  total: number;
  grouping: Grouping;
  setGrouping: (v: Grouping) => void;
}) {
  const active = filtersActive(filters);
  return (
    <div className="sticky top-0 z-20 mb-2 bg-sol-bg/85 backdrop-blur border-b border-sol-border/40">
      <div className="relative border-b border-sol-border/40 focus-within:border-sol-cyan/70 transition-colors">
        <Search className="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sol-text-dim pointer-events-none" />
        <input
          id="trigger-search"
          value={filters.search}
          onChange={(e) => update({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              update({ search: "" });
              e.currentTarget.blur();
            }
          }}
          placeholder="Search title, prompt, last result…"
          className="w-full bg-transparent pl-6 pr-6 py-2.5 text-xs text-sol-text placeholder:text-sol-text-dim focus:outline-none"
        />
        {filters.search && (
          <ShortcutTooltip label="Clear search">
            <button
              onClick={() => update({ search: "" })}
              aria-label="Clear search"
              className="absolute right-0 top-1/2 -translate-y-1/2 text-sol-text-dim hover:text-sol-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </ShortcutTooltip>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 text-[11px]">
        <div className="flex items-center gap-3">
          {TYPE_TOGGLES.filter((p) => p.key !== "event" || hasEvent).map(({ key, label, Icon, on }) => (
            <button
              key={key}
              onClick={() => update({ type: filters.type === key ? "all" : key })}
              aria-pressed={filters.type === key}
              className={`inline-flex items-center gap-1 py-1 font-medium transition-colors ${
                filters.type === key ? on : "text-sol-text-dim hover:text-sol-text"
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>
        <SelectBox variant="bare" className="text-[11px]" value={filters.mode} onChange={(e) => update({ mode: e.target.value })}>
          <option value="all">all modes</option>
          <option value="apply">makes changes</option>
          <option value="propose">read-only</option>
        </SelectBox>
        {projects.length > 1 && (
          <SelectBox variant="bare" className="text-[11px]" value={filters.project} onChange={(e) => update({ project: e.target.value })}>
            <option value="all">all projects</option>
            {projects.map((p) => <option key={p} value={p}>{projectName(p)}</option>)}
          </SelectBox>
        )}
        {hasCodex && (
          <SelectBox variant="bare" className="text-[11px]" value={filters.agent} onChange={(e) => update({ agent: e.target.value })}>
            <option value="all">all agents</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </SelectBox>
        )}
        {/* The same grouping the inbox roster uses — by the session each
            trigger fires into — is the default; project and flat are a
            click away. */}
        <span className="inline-flex items-center gap-1.5 text-sol-text-dim">
          <span>by</span>
          <SegmentedToggle
            variant="bare"
            value={grouping}
            onChange={(g) => setGrouping(g as Grouping)}
            items={[
              { key: "session", label: "session" },
              { key: "project", label: "project" },
              { key: "none", label: "none" },
            ]}
          />
        </span>
        {active && (
          <span className="ml-auto inline-flex items-center gap-2 text-sol-text-dim">
            <span className="tabular-nums">{shown} of {total}</span>
            <button onClick={() => update(EMPTY_FILTERS)} className="hover:text-sol-text underline underline-offset-2">
              clear
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// ── Rows ──

// The inline editor (edit / duplicate) is the ONE thing a row unfolds on this
// page; reading — last result, run history, prompt — is the trigger page's
// job, one click on the row away. Row-local form state lives here, keyed by
// task id, so a deep link (?task=X&edit=1 from the trigger page's Edit verb,
// or &duplicate=1 from the palette) can open it from above.
type RowForm = { id: string; mode: "edit" | "duplicate" } | null;

function PageRow({ task, isNext, form, setForm, deepLinked }: {
  task: TaskRow;
  isNext?: boolean;
  form: RowForm;
  setForm: (f: RowForm) => void;
  deepLinked: boolean;
}) {
  const router = useRouter();
  const deleteTrigger = useInboxStore((st) => st.deleteTrigger);
  const rowRef = useRef<HTMLDivElement>(null);
  // Scroll the deep-linked row into view when it BECOMES the target — a later
  // click on another trigger changes only the query on this mounted page.
  useWatchEffect(() => {
    if (deepLinked) rowRef.current?.scrollIntoView({ block: "center" });
  }, [deepLinked]);
  // openId only feeds the row's "active session" tint, which this page never
  // shows (no activeSessionId here): the row's click opens the trigger page.
  const row = useMemo<TriggerRow>(
    () => ({ task, openId: task.originating_conversation_id ?? task.last_run_conversation_id, unread: false }),
    [task],
  );
  const terminal = task.status === "completed" || task.status === "failed";
  const mode = form?.id === task._id ? form.mode : null;
  return (
    <div ref={rowRef}>
      <TriggerRowItem
        row={row}
        variant="page"
        isNext={isNext}
        highlighted={deepLinked && !mode}
        onOpen={() => router.push(`/triggers/${task.short_id ?? task._id}`)}
        onEdit={() => setForm({ id: task._id, mode: "edit" })}
        onDuplicate={() => setForm({ id: task._id, mode: "duplicate" })}
        onDelete={terminal ? () => { deleteTrigger(task._id); toast.success("Deleted"); } : undefined}
      />
      {mode && (
        <div className="px-4 pb-3 border-b border-sol-border/40 bg-sol-bg-alt/25 animate-fadeSlideIn">
          <TriggerForm
            embedded
            editTask={mode === "edit" ? task : undefined}
            seedTask={mode === "duplicate" ? task : undefined}
            onClose={() => setForm(null)}
          />
        </div>
      )}
    </div>
  );
}

// The band above a group of rows — a project, a day, a home session.
const bandCls = "flex items-center gap-1.5 text-[11px] text-sol-text-dim py-1.5 px-4 bg-sol-bg-alt/30 border-b border-sol-border/40";

function groupByProjectPath(tasks: TaskRow[]): [string, TaskRow[]][] {
  const groups = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const key = t.project_path || "— no project";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

// A home-session header for the page: the roster's header, fed from the
// store's session row so the state word and dot are live.
function PageHomeHeader({ group, now, showProject }: { group: TriggerHomeGroup; now: number; showProject: boolean }) {
  const router = useRouter();
  const home = useInboxStore((st) => (group.homeId ? st.sessions[group.homeId] : undefined));
  const first = group.rows[0].task;
  const open = () => {
    const id = group.homeId ?? first.last_run_conversation_id ?? first.created_by_conversation_id;
    if (id) router.push(`/conversation/${id}`);
  };
  return <TriggerHomeHeader group={group} home={home} now={now} isActive={false} showProject={showProject} onOpen={open} size="md" />;
}

type RowListProps = {
  tasks: TaskRow[];
  now: number;
  grouping: Grouping;
  nextId?: string;
  form: RowForm;
  setForm: (f: RowForm) => void;
  deepLinkId?: string;
  showProject: boolean;
};

function RowList({ tasks, now, grouping, nextId, form, setForm, deepLinkId, showProject }: RowListProps) {
  const isTarget = (t: TaskRow) => !!deepLinkId && (deepLinkId === t._id || deepLinkId.toLowerCase() === t.short_id);
  const rowOf = (t: TaskRow) => (
    <PageRow key={t._id} task={t} isNext={t._id === nextId} form={form} setForm={setForm} deepLinked={isTarget(t)} />
  );
  if (grouping === "none") return <>{tasks.map(rowOf)}</>;
  if (grouping === "project") {
    return (
      <>
        {groupByProjectPath(tasks).map(([proj, rows]) => (
          <div key={proj} className="flex flex-col">
            <div className={bandCls}>
              {proj.startsWith("—") ? proj : projectName(proj)}
              <span className="font-mono text-sol-text-dim/60">{rows.length}</span>
            </div>
            {rows.map(rowOf)}
          </div>
        ))}
      </>
    );
  }
  const groups = groupTriggerRowsByHome(tasks.map((task) => ({ task, unread: false })));
  return (
    <>
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col">
          <PageHomeHeader group={g} now={now} showProject={showProject} />
          {g.rows.map((r) => rowOf(r.task))}
        </div>
      ))}
    </>
  );
}

// ── History: analytics + day-grouped, paginated finished runs ──

function dayBucket(ts: number, now: number): string {
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 30) return "Earlier this month";
  return "Older";
}

const DAY_ORDER = ["Today", "Yesterday", "Earlier this week", "Earlier this month", "Older"];

function groupByDay(tasks: TaskRow[], now: number): [string, TaskRow[]][] {
  const groups = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const key = dayBucket(t.last_run_at ?? t.created_at, now);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return DAY_ORDER.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)!]);
}

const HISTORY_PAGE = 25;

function HistoryBody({ tasks, now, grouping, form, setForm, deepLinkId }: {
  tasks: TaskRow[];
  now: number;
  grouping: Grouping;
  form: RowForm;
  setForm: (f: RowForm) => void;
  deepLinkId?: string;
}) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [limit, setLimit] = useState(HISTORY_PAGE);

  const succeeded = useMemo(() => tasks.filter((t) => t.status === "completed").length, [tasks]);
  const failed = tasks.length - succeeded;
  const rate = tasks.length ? Math.round((succeeded / tasks.length) * 100) : 0;

  const shown = failuresOnly ? tasks.filter((t) => t.status === "failed") : tasks;
  const visible = shown.slice(0, limit);
  const rowOf = (t: TaskRow) => (
    <PageRow
      key={t._id}
      task={t}
      form={form}
      setForm={setForm}
      deepLinked={!!deepLinkId && (deepLinkId === t._id || deepLinkId.toLowerCase() === t.short_id)}
    />
  );

  return (
    <div className="flex flex-col">
      {/* success / failure proportion — a text line and a thin bar, no box */}
      <div className="px-4 py-2.5 border-b border-sol-border/40">
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="text-sol-text-dim">
            <span className="text-emerald-400">{succeeded} succeeded</span>
            {failed > 0 && <> · <span className="text-sol-red">{failed} failed</span></>}
          </span>
          <span className="text-sol-text-muted tabular-nums">{rate}% success</span>
        </div>
        <div className="h-1.5 rounded-full bg-sol-bg-alt overflow-hidden flex">
          <div className="bg-emerald-500/70 h-full transition-all" style={{ width: `${(succeeded / Math.max(tasks.length, 1)) * 100}%` }} />
          <div className="bg-sol-red/70 h-full transition-all" style={{ width: `${(failed / Math.max(tasks.length, 1)) * 100}%` }} />
        </div>
      </div>

      {failed > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/40">
          <button
            onClick={() => setFailuresOnly((v) => !v)}
            className={`inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-1 transition-colors ${
              failuresOnly
                ? "text-sol-red bg-sol-red/15"
                : "bg-sol-bg-alt text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight"
            }`}
          >
            <AlertTriangle className="w-3 h-3" /> failures only
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-[11px] text-sol-text-dim py-3 px-4">No failures — every finished run succeeded.</p>
      ) : grouping === "project" ? (
        groupByProjectPath(visible).map(([proj, rows]) => (
          <div key={proj} className="flex flex-col">
            <div className={bandCls}>
              {proj.startsWith("—") ? proj : projectName(proj)}
              <span className="font-mono text-sol-text-dim/60">{rows.length}</span>
            </div>
            {rows.map(rowOf)}
          </div>
        ))
      ) : (
        // Finished runs read by day, whichever grouping the live list uses —
        // a finished one-time's home session is history too.
        groupByDay(visible, now).map(([label, rows]) => (
          <div key={label} className="flex flex-col">
            <div className={bandCls}>{label}<span className="font-mono text-sol-text-dim/60">{rows.length}</span></div>
            {rows.map(rowOf)}
          </div>
        ))
      )}

      {shown.length > limit && (
        <button
          onClick={() => setLimit((l) => l + HISTORY_PAGE)}
          className="self-start text-[11px] text-sol-cyan hover:underline underline-offset-2 mt-2 px-4"
        >
          show {Math.min(HISTORY_PAGE, shown.length - limit)} more · {shown.length - limit} hidden
        </button>
      )}
    </div>
  );
}

function FilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <ListFilter className="w-7 h-7 text-sol-text-dim" />
      <p className="text-sm text-sol-text-muted">No triggers match these filters</p>
      <button
        onClick={onClear}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-sol-bg-alt text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight transition-colors"
      >
        Clear filters
      </button>
    </div>
  );
}

function TriggersContent() {
  // Store-fed (hooks/useSyncTriggers): the list paints from the cached roster
  // synchronously; the feeder keeps it fresh. `undefined` only while the cache
  // is empty AND the first answer is in flight.
  const { tasks: taskRows, ready: tasksReady } = useTriggers();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const tasks: TaskRow[] | undefined = tasksReady || taskRows.length > 0 ? taskRows : undefined;
  // Deep links, read REACTIVELY (tab-context searchParams): the tab shell
  // keeps this page mounted, so a later click on another trigger changes only
  // the query. ?new=1 (the dock's "+ New") lands with the create form open;
  // ?task=<id|tr-N> scrolls to that row; &edit=1 / &duplicate=1 open its form.
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get("task") ?? undefined;
  const deepLinkMode = searchParams.get("edit") === "1" ? "edit" : searchParams.get("duplicate") === "1" ? "duplicate" : null;
  const [showForm, setShowForm] = useState(() => searchParams.get("new") === "1");
  const [form, setForm] = useState<RowForm>(null);
  useWatchEffect(() => {
    if (searchParams.get("new") === "1") setShowForm(true);
  }, [searchParams]);
  // The deep-linked row's form opens once its row can be found — by Convex id
  // or by short id (the palette links by whichever it has).
  useWatchEffect(() => {
    if (!deepLinkId || !deepLinkMode || !tasks) return;
    const target = tasks.find((t) => t._id === deepLinkId || t.short_id === deepLinkId.toLowerCase());
    if (target) setForm({ id: target._id, mode: deepLinkMode });
  }, [deepLinkId, deepLinkMode, tasks === undefined]);
  const [now, setNow] = useState(() => Date.now());

  // Tick so countdowns ("in 23m", "due now") stay live without resubscribing.
  useMountEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  });

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const update = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const [grouping, setGrouping] = useState<Grouping>("session");

  // Filters drive the list AND the rail so what's shown stays consistent. Stats
  // and the failure banner stay global — they're a health overview of everything.
  const filtered = useMemo(
    () => (tasks ?? []).filter((t) => matchesFilters(t, filters)),
    [tasks, filters]
  );

  const { active, paused, history } = useMemo(() => {
    return {
      // Live runs first, then soonest fire — the roster's order.
      active: filtered
        .filter((t) => t.status === "scheduled" || t.status === "running")
        .sort((a, b) => {
          const ra = a.status === "running" ? 0 : 1, rb = b.status === "running" ? 0 : 1;
          return ra !== rb ? ra - rb : (a.run_at ?? Infinity) - (b.run_at ?? Infinity);
        }),
      paused: filtered.filter((t) => t.status === "paused"),
      history: filtered
        .filter((t) => t.status === "completed" || t.status === "failed")
        .sort((a, b) => (b.last_run_at ?? b.created_at) - (a.last_run_at ?? a.created_at)),
    };
  }, [filtered]);

  const stats = useMemo(() => computeStats(tasks ?? [], now), [tasks, now]);
  const failingActive = useMemo(
    () => (tasks ?? []).filter((t) => (t.status === "scheduled" || t.status === "running") && isTriggerFailing(t)),
    [tasks]
  );
  const projects = useMemo(
    () => ([...new Set((tasks ?? []).map((t) => t.project_path).filter(Boolean))] as string[]).sort(),
    [tasks]
  );
  const hasCodex = useMemo(() => (tasks ?? []).some((t) => t.agent_type === "codex"), [tasks]);
  const hasEvent = useMemo(() => (tasks ?? []).some((t) => t.schedule_type === "event"), [tasks]);

  const activeSubtitle = useMemo(() => {
    const recurring = active.filter((t) => t.schedule_type === "recurring").length;
    const oneTime = active.filter((t) => t.schedule_type === "once").length;
    const events = active.filter((t) => t.schedule_type === "event").length;
    const parts: string[] = [];
    if (recurring > 0) parts.push(`${recurring} recurring`);
    if (oneTime > 0) parts.push(`${oneTime} one-time`);
    if (events > 0) parts.push(`${events} on event`);
    return parts.join(" · ") || undefined;
  }, [active]);
  const historyFailed = useMemo(() => history.filter((t) => t.status === "failed").length, [history]);

  // The soonest upcoming run gets an "up next" accent. active is sorted by run_at
  // ascending, so the first scheduled row with a future run_at is the winner.
  const nextId = useMemo(() => {
    const next = active.find((t) => t.status === "scheduled" && t.run_at && t.run_at > now);
    return next?._id as string | undefined;
  }, [active, now]);

  const hasTasks = tasks !== undefined && tasks.length > 0;
  const anyShown = active.length + paused.length + history.length > 0;
  const listProps = { now, grouping, form, setForm, deepLinkId, showProject: projects.length > 1 };

  return (
    <div className="h-full overflow-y-auto bg-sol-bg" data-main-scroll>
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div ref={titlebarRef} className="flex items-center gap-2 mb-5">
          <Zap className="w-4 h-4 text-sol-amber" />
          <h1 className="text-lg font-semibold text-sol-text">Triggers</h1>
          <span className="text-xs text-sol-text-dim">agents that run on their own, later</span>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-sol-amber text-sol-bg hover:bg-sol-amber/90 active:scale-[0.97] transition-all"
          >
            <Plus className="w-3.5 h-3.5" /> New trigger
          </button>
        </div>

        {showForm && <TriggerForm onClose={() => setShowForm(false)} />}

        {tasks === undefined ? (
          <AppLoader className="min-h-[16rem] h-full" />
        ) : tasks.length === 0 && !showForm ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <Zap className="w-8 h-8 text-sol-text-dim" />
            <p className="text-sm text-sol-text-muted">No triggers yet</p>
            <p className="text-xs text-sol-text-dim max-w-sm">
              Set triggers to run agents later — check CI, review PRs, continue work — from here or any session:
            </p>
            <code className="font-mono text-xs text-sol-text-muted bg-sol-bg-alt rounded-md px-3 py-1.5">
              cast trigger add "Check CI on main" --in 30m
            </code>
            <button
              onClick={() => setShowForm(true)}
              className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-sol-amber text-sol-bg hover:bg-sol-amber/90 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> New trigger
            </button>
          </div>
        ) : (
          <>
            {/* The overview sits on the page, not in a box: one line of
                numbers under the title, the ±24h rail beneath it, the failed
                names if any — everything on the title's left edge. The sticky
                filter bar's hairline closes it. The rail plots all filtered
                tasks, not just active: finished one-times and paused loops
                still own dots on the past half. */}
            {hasTasks && (
              <div className="reveal mb-4">
                <OverviewLine stats={stats} now={now} filters={filters} update={update} />
                <HorizonRail tasks={filtered} now={now} />
                <AttentionBanner tasks={failingActive} />
              </div>
            )}
            <FilterBar
              filters={filters}
              update={update}
              projects={projects}
              hasCodex={hasCodex}
              hasEvent={hasEvent}
              shown={filtered.length}
              total={tasks.length}
              grouping={grouping}
              setGrouping={setGrouping}
            />
            {!anyShown ? (
              <FilteredEmpty onClear={() => update(EMPTY_FILTERS)} />
            ) : (
              <div className="reveal reveal-2">
                {/* The overview line already says the split; repeat it here
                    only when a filter makes the section's split differ. */}
                <Section title="Active" count={active.length} subtitle={filtersActive(filters) ? activeSubtitle : undefined}>
                  <RowList tasks={active} nextId={nextId} {...listProps} />
                </Section>
                <Section title="Paused" count={paused.length}>
                  <RowList tasks={paused} {...listProps} />
                </Section>
                <Section
                  title="History"
                  count={history.length}
                  subtitle={historyFailed > 0 ? `${historyFailed} failed` : "all succeeded"}
                  defaultOpen={active.length === 0}
                >
                  <HistoryBody tasks={history} now={now} grouping={grouping} form={form} setForm={setForm} deepLinkId={deepLinkId} />
                </Section>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function TriggersPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <TriggersContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
