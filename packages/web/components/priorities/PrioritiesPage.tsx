"use client";
// /priorities: what each person is driving at, inferred from their own
// sessions (convex/priorities.ts). One row per priority in the person's order,
// its critical path and its last 15 days of typing; a row opens into its steps
// with their tasks, sessions and pull requests. The person drags a row to
// rank it and a step across the line between Critical path and Polish, and
// sets a priority aside or brings it back; the pass never overrides those.
// Finished priorities stay listed, won; quiet and set-aside ones grey.
import { useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Check, ChevronRight, GripVertical, Loader2, MoreHorizontal, Play, Plus, Target } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityStep, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { usePriorities, usePriorityListMeta, usePriorityWrites, useRunPriorities, useSyncPriorities } from "../../hooks/usePriorities";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { Button } from "../ui/button";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { cn } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { PageFrame, PageHeader } from "../ui/page-header";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { HistoryStrip } from "./HistoryStrip";
import {
  behindLabel, mostActiveSessions, newSessionHref, nextPassLabel, passDue, ownerGroups, pastBadge, rankAtDrop, stepCounts, stepNeedsSession, stepSessions, stripLevels,
  type PriorityHistoryLane, type OwnerGroup, type PriorityDetail, type PriorityHistory, type PriorityRow, type PriorityWrites,
} from "../../lib/priorities";

const api = _api as any;
const DAYS = 15;

export default function PrioritiesPage() {
  const workspace = useActiveWorkspaceKey();
  const feed = useSyncPriorities();
  const rows = usePriorities();
  // History is computed on read from typed messages (no table to mirror), so
  // it is an enrichment read beside the store, like the repo's other
  // server-computed reads: the rows paint without it.
  const history = useQueryNoThrow(
    api.priorities.history,
    workspace ? { workspace, days: DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : "skip",
    { remember: true },
  );
  const writes = usePriorityWrites(rows);
  const meta = usePriorityListMeta();
  const pass = useRunPriorities(rows.length);
  const now = useCoarseNow(30_000);
  const behind = behindLabel(meta.behind_by_ms);

  const router = useRouter();
  const params = useSearchParams();
  const openId = params?.get("open") ?? null;
  const toggleOpen = (shortId: string) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (openId === shortId) next.delete("open");
    else next.set("open", shortId);
    const qs = next.toString();
    router.replace(qs ? `/priorities?${qs}` : "/priorities");
  };

  const behindChip = behind ? <BehindChip label={behind} /> : undefined;
  const legacy = <h1 className="flex items-center gap-2 px-4 pt-6 text-title font-semibold text-sol-text">Priorities{behindChip}</h1>;
  const active = rows.filter((r) => r.status === "active").length;

  let body: ReactNode;
  if (rows.length === 0 && feed.error) {
    body = (
      <EmptyState icon={AlertTriangle} title="Priorities didn't load" action={{ label: "Try again", onClick: feed.retry }}>
        <details className="max-w-md text-meta text-sol-text-dim">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 break-words">{feed.error.message}</p>
        </details>
      </EmptyState>
    );
  } else if (rows.length === 0 && !feed.ready) {
    body = <SkeletonRows rows={5} className="pt-2" rowClassName="h-9" />;
  } else if (rows.length === 0) {
    body = <NoPrioritiesYet nextPass={nextPassLabel(meta.next_pass_at, now)} running={pass.running || passDue(meta, now)} onRun={pass.run} />;
  } else {
    body = <PrioritiesView rows={rows} history={history.data as PriorityHistory | undefined} openId={openId} onToggleOpen={toggleOpen} writes={writes} />;
  }

  return (
    <PageFrame
      header={<PageHeader legacy={legacy} title="Priorities" icon={Target} count={rows.length ? active : null} status={behindChip} />}
      legacyColumn="mx-auto w-full max-w-[1080px]"
      column="mx-auto w-full max-w-[1080px] px-4 pb-16 pt-3"
    >
      {body}
    </PageFrame>
  );
}

/** The pass has fallen behind its schedule: priorities may miss the newest sessions. */
export function BehindChip({ label }: { label: string }) {
  return (
    <span
      data-priorities-behind
      title="The priorities pass has run late: the newest sessions may not be in these priorities yet."
      className="inline-flex shrink-0 items-center rounded-full border border-sol-yellow/40 bg-sol-yellow/10 px-2 py-0.5 text-meta font-medium text-sol-yellow"
    >
      {label}
    </span>
  );
}

/** A one-time act that starts a model run: reviewed before it starts (components/consequential). */
const RUN_LEDGER: SwitchLedger = {
  name: "Run a pass now",
  subject: "Your priorities in this workspace",
  shift: null,
  figures: [{ value: "1", label: "model run" }],
  rows: [
    { k: "Reads", v: "Your sessions and typed messages" },
    { k: "Writes", v: "Your priorities here" },
    { k: "Keeps", v: "Your ranks, tiers and set-asides" },
  ],
  confirm: "Run now",
  keep: "Not now",
};

/** No priorities yet: when the next pass runs, and a pass now. */
export function NoPrioritiesYet({ nextPass, running, onRun }: { nextPass: string | null; running: boolean; onRun: (() => void) | null }) {
  const [reviewing, setReviewing] = useState(false);
  const action = running ? (
    <Button size="sm" variant="secondary" disabled data-priorities-running>
      <Loader2 className="animate-spin" /> Running
    </Button>
  ) : onRun ? (
    <Button size="sm" variant="primary" onClick={() => setReviewing(true)}>
      <Play /> Run now
    </Button>
  ) : undefined;
  return (
    <EmptyState icon={Target} title="No priorities yet" action={action}>
      {nextPass && !running && <p data-next-pass className="text-meta tabular-nums text-sol-text-dim">{nextPass}</p>}
      {reviewing && onRun && (
        <SwitchReview ledger={RUN_LEDGER} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); onRun(); }} />
      )}
    </EmptyState>
  );
}

/**
 * The grid every priority row, the day header and each open row's steps
 * share, so the strips line up. Columns join by the LIST's width, not the
 * window's (the list sits beside the inbox panel): from 28rem the
 * critical-path bar, from 36rem the 15-day strip. The strip is one width for
 * the whole page (--pri-strip): what the list has past a title's room
 * (26rem), between 9rem and 300px. A fixed-maximum column would take its
 * 300px before a title got any.
 */
const ROW_GRID = "grid grid-cols-[28px_minmax(0,1fr)_auto_24px] items-center gap-3 [@container(min-width:28rem)]:grid-cols-[28px_minmax(0,1fr)_96px_40px_24px] [@container(min-width:36rem)]:grid-cols-[28px_minmax(0,1fr)_96px_40px_var(--pri-strip)_24px]";
const STEP_GRID = "grid grid-cols-[14px_18px_minmax(0,1fr)] items-start gap-2 [@container(min-width:36rem)]:grid-cols-[14px_18px_minmax(0,1fr)_var(--pri-strip)]";
/** The list's width less a row's fixed columns, gaps and padding (17rem) and a title's room (26rem). */
const STRIP_WIDTH = { containerType: "inline-size", "--pri-strip": "clamp(9rem, calc(100cqw - 43rem), 300px)" } as CSSProperties;

export function PrioritiesView({
  rows,
  history,
  openId,
  onToggleOpen,
  writes,
}: {
  rows: PriorityRow[];
  history: PriorityHistory | undefined;
  openId: string | null;
  onToggleOpen: (shortId: string) => void;
  writes: PriorityWrites;
}) {
  const groups = ownerGroups(rows);
  const lanes = useMemo(() => new Map((history?.lanes ?? []).map((l) => [l.short_id ?? l.key, l as PriorityHistoryLane])), [history]);
  const levels = useMemo(() => stripLevels([...lanes.values()].map((l) => l.counts)), [lanes]);
  const days = history?.days ?? [];
  const showOwners = groups.length > 1 || (groups[0] && !groups[0].mine);
  return (
    <div data-priorities className="space-y-6" style={STRIP_WIDTH}>
      {groups.map((g) => (
        <section key={g.user_id} data-owner={g.user_id}>
          {showOwners && <h2 className="mb-2 text-ui font-semibold text-sol-text">{g.mine ? "You" : g.owner || "Teammate"}</h2>}
          {days.length > 0 && <DayHeader days={days} />}
          <ActiveList group={g} lanes={lanes} levels={levels} history={history} openId={openId} onToggleOpen={onToggleOpen} writes={writes} />
          {g.past.length > 0 && (
            <>
              <h3 className="mb-1.5 mt-5 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">
                Finished and past{showOwners && !g.mine && <span className="font-normal"> · {g.owner || "Teammate"}</span>}
              </h3>
              <div className="space-y-1.5">
                {g.past.map((r) => (
                  <PastRow key={r.short_id} row={r} lane={lanes.get(r.short_id)} days={days} levels={levels} writes={writes} />
                ))}
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

function DayHeader({ days }: { days: string[] }) {
  return (
    <div aria-hidden className={cn(ROW_GRID, "hidden px-3 pb-1 text-mark text-sol-text-dim [@container(min-width:36rem)]:grid")}>
      <span />
      <span />
      <span>Critical path</span>
      <span />
      <span className="grid gap-[3px] text-center" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) => (
          // Every other day's number while the strip is too narrow for all fifteen.
          <span key={d} className={i % 2 ? "[@container(max-width:58rem)]:invisible" : undefined}>{Number(d.slice(8))}</span>
        ))}
      </span>
      <span />
    </div>
  );
}

/** An owner's active priorities; the owner drags a row to give it that rank. */
function ActiveList({ group, lanes, levels, history, openId, onToggleOpen, writes }: {
  group: OwnerGroup;
  lanes: Map<string, PriorityHistoryLane>;
  levels: number[];
  history: PriorityHistory | undefined;
  openId: string | null;
  onToggleOpen: (shortId: string) => void;
  writes: PriorityWrites;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const drop = (index: number) => {
    const from = group.active.findIndex((r) => r.short_id === dragging);
    if (dragging && from !== -1 && from !== index) writes.rank(dragging, rankAtDrop(index));
    setDragging(null);
    setOver(null);
  };
  if (group.active.length === 0) return null;
  return (
    <ol className="space-y-1.5">
      {group.active.map((r, i) => (
        <li
          key={r.short_id}
          data-priority={r.short_id}
          onDragOver={(e: DragEvent) => { if (dragging) { e.preventDefault(); setOver(i); } }}
          onDrop={(e: DragEvent) => { if (dragging) { e.preventDefault(); drop(i); } }}
          className={cn(
            "rounded-lg border border-sol-border/60 bg-sol-bg-alt/50",
            dragging === r.short_id && "opacity-40",
            over === i && dragging !== r.short_id && "ring-1 ring-sol-blue/50",
          )}
        >
          {/* The row's head is the handle: a drag that starts in its open steps moves a step. */}
          <div
            draggable={r.mine}
            onDragStart={(e: DragEvent) => { e.dataTransfer.effectAllowed = "move"; setDragging(r.short_id); }}
            onDragEnd={() => { setDragging(null); setOver(null); }}
          >
            <ActiveRow row={r} position={i + 1} total={group.active.length} lane={lanes.get(r.short_id)} days={history?.days ?? []} levels={levels} open={openId === r.short_id} onToggle={() => onToggleOpen(r.short_id)} writes={writes} />
          </div>
          {openId === r.short_id && <PriorityBody row={r} history={history} writes={writes} />}
        </li>
      ))}
    </ol>
  );
}

function CriticalBar({ steps }: { steps: PriorityStep[] }) {
  const critical = steps.filter((s) => s.tier === "critical");
  return (
    <span className="hidden max-w-[96px] gap-0.5 [@container(min-width:28rem)]:flex">
      {critical.map((s) => (
        <i key={s.key} className={cn("block h-2.5 min-w-[3px] max-w-[11px] flex-1 rounded-[2px]", s.done ? "bg-sol-green" : "bg-sol-text/10")} />
      ))}
    </span>
  );
}

function ActiveRow({ row, position, total, lane, days, levels, open, onToggle, writes }: {
  row: PriorityRow;
  position: number;
  /** How many active priorities the owner has: the positions "Move to" offers. */
  total: number;
  lane: PriorityHistoryLane | undefined;
  days: string[];
  levels: number[];
  open: boolean;
  onToggle: () => void;
  writes: PriorityWrites;
}) {
  return (
    <div className={cn(ROW_GRID, "px-3 py-2")}>
      <span className="group/rank flex items-center gap-0.5 text-ui font-semibold tabular-nums text-sol-text-dim">
        {row.mine && <GripVertical aria-hidden className="-ml-2 size-3 cursor-grab opacity-0 group-hover/rank:opacity-100" />}
        {position}
      </span>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 items-center gap-1.5 text-left">
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-sol-text-dim transition-transform", open && "rotate-90")} />
        <span className="truncate text-body font-semibold text-sol-text" title={row.title}>{row.title}</span>
      </button>
      <CriticalBar steps={row.steps} />
      <span className="text-right text-ui tabular-nums text-sol-text-muted" title={`${row.counts.critical_done} of ${row.counts.critical_total} critical-path steps done`}>
        {row.counts.critical_done}/{row.counts.critical_total}
      </span>
      {days.length > 0 && <span className="hidden [@container(min-width:36rem)]:block"><HistoryStrip days={days} counts={lane?.counts} truncated={lane?.truncated} levels={levels} /></span>}
      <RowMenu row={row} position={position} total={total} writes={writes} />
    </div>
  );
}

/** Set aside or restore, and for an active priority "Move to" each other position: ranking without a drag (touch screens). */
function RowMenu({ row, writes, position, total = 0 }: { row: PriorityRow; writes: PriorityWrites; position?: number; total?: number }) {
  if (!row.mine) return <span />;
  const moves = row.status === "active" ? Array.from({ length: total }, (_, i) => i + 1).filter((n) => n !== position) : [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`More for ${row.title}`} className="rounded p-1 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text">
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {moves.length > 0 && (
          <>
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {moves.map((n) => (
              <DropdownMenuItem key={n} data-move-to={n} onSelect={() => writes.rank(row.short_id, n)}>#{n}</DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {row.status === "active"
          ? <DropdownMenuItem onSelect={() => writes.setAside(row.short_id)}>Set aside</DropdownMenuItem>
          : <DropdownMenuItem onSelect={() => writes.restore(row.short_id)}>Restore</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PastRow({ row, lane, days, levels, writes }: {
  row: PriorityRow;
  lane: PriorityHistoryLane | undefined;
  days: string[];
  levels: number[];
  writes: PriorityWrites;
}) {
  const won = row.status === "done";
  return (
    <div
      data-priority={row.short_id}
      data-status={row.status}
      className={cn(
        ROW_GRID,
        "rounded-lg border px-3 py-2",
        won ? "border-sol-green/40 bg-sol-green/[0.07]" : "border-sol-border/50 bg-transparent",
      )}
    >
      <span />
      {/* The title takes the room it needs first; the goal it served gets what is left, clipped, never over the title. */}
      <span className={cn("flex min-w-0 items-center gap-2", !won && "text-sol-text-muted")}>
        <span data-past-title className={cn("max-w-full shrink-0 truncate text-body", won ? "font-semibold text-sol-text" : "font-medium")} title={row.title}>{row.title}</span>
        {row.serves && <span data-past-serves className="hidden min-w-0 overflow-hidden text-meta [@container(min-width:28rem)]:inline-flex"><EntityIdPill shortId={row.serves} type="initiative" compact /></span>}
      </span>
      <span className="justify-self-end [@container(min-width:28rem)]:col-span-2">
        {won
          ? <span className="inline-flex items-center rounded-full bg-sol-green px-2.5 py-0.5 text-meta font-semibold text-sol-bg">{pastBadge(row)}</span>
          : <span className="whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>}
      </span>
      {days.length > 0 && <span className="hidden [@container(min-width:36rem)]:block"><HistoryStrip days={days} counts={lane?.counts} truncated={lane?.truncated} levels={levels} muted={!won} /></span>}
      <RowMenu row={row} writes={writes} />
    </div>
  );
}

/** An open priority: where it stands, what it serves, its steps on either side of the line, and its busiest sessions. */
function PriorityBody({ row, history, writes }: { row: PriorityRow; history: PriorityHistory | undefined; writes: PriorityWrites }) {
  const [dragStep, setDragStep] = useState<string | null>(null);
  const [overTier, setOverTier] = useState<PriorityStepTier | null>(null);
  // The list row holds only the newest few sessions; the open row reads every one, by step.
  const detail = useQueryNoThrow(api.priorities.show, { short_id: row.short_id }, { remember: true }).data as PriorityDetail | null | undefined;
  const active = mostActiveSessions(row, history, detail);
  const lead = active[0];
  const days = history?.days ?? [];
  const dropOn = (tier: PriorityStepTier) => {
    const step = row.steps.find((s) => s.key === dragStep);
    if (step && step.tier !== tier) writes.setStepTier(row.short_id, step.key, tier);
    setDragStep(null);
    setOverTier(null);
  };
  const group = (tier: PriorityStepTier, label: string) => {
    const steps = row.steps.filter((s) => s.tier === tier);
    return (
      <div className="mt-3">
        <h4 className="mb-1 text-meta font-semibold text-sol-text">
          {label} <span className="font-normal tabular-nums text-sol-text-dim">{steps.filter((s) => s.done).length}/{steps.length}</span>
        </h4>
        <ul
          data-tier={tier}
          onDragOver={(e) => { if (dragStep) { e.preventDefault(); setOverTier(tier); } }}
          onDragLeave={() => setOverTier((t) => (t === tier ? null : t))}
          onDrop={(e) => { e.preventDefault(); dropOn(tier); }}
          className={cn(
            "min-h-8 rounded-control",
            tier === "polish" && "border-t-2 border-dashed border-sol-border/70 pt-0.5",
            overTier === tier && "bg-sol-blue/[0.06]",
          )}
        >
          {steps.map((s) => (
            <StepLine
              key={s.key}
              row={row}
              step={s}
              history={history}
              detail={detail}
              days={days}
              dragging={dragStep === s.key}
              onDragStart={row.mine ? () => setDragStep(s.key) : undefined}
              onDragEnd={() => { setDragStep(null); setOverTier(null); }}
              onMoveTier={row.mine ? (to) => writes.setStepTier(row.short_id, s.key, to) : undefined}
            />
          ))}
        </ul>
      </div>
    );
  };
  return (
    <div data-priority-body className="border-t border-sol-border/40 px-3 pb-3 pt-2 [@container(min-width:28rem)]:pl-[52px] [@container(min-width:36rem)]:pr-12">
      {row.summary && <p className="text-ui text-sol-text-muted">{row.summary}</p>}
      {(row.serves || lead) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {row.serves && <EntityIdPill shortId={row.serves} type="initiative" />}
          {lead && <EntityIdPill shortId={lead.short_id} type="session" />}
        </div>
      )}
      {group("critical", "Critical path")}
      {group("polish", "Polish and follow-ups")}
      {active.length > 0 && (
        <div className="mt-3">
          <h4 className="mb-1 text-meta font-semibold text-sol-text">Most active sessions</h4>
          <ul>
            {active.map((s) => (
              <li key={s.short_id} className="grid grid-cols-[minmax(0,1fr)] items-center gap-2 py-0.5 [@container(min-width:36rem)]:grid-cols-[minmax(0,1fr)_var(--pri-strip)]">
                <span className="min-w-0"><EntityIdPill shortId={s.short_id} type="session" label={s.title || undefined} /></span>
                {days.length > 0 && <span className="hidden [@container(min-width:36rem)]:block"><HistoryStrip days={days} counts={stepCounts(history, [s])} size="step" /></span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const MAX_STEP_SESSIONS = 3;

/** The tier move without a drag, for touch and keyboard. */
function StepMenu({ step, onMoveTier }: { step: PriorityStep; onMoveTier: (tier: PriorityStepTier) => void }) {
  const to: PriorityStepTier = step.tier === "critical" ? "polish" : "critical";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`More for ${step.title}`} className="shrink-0 rounded p-0.5 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text">
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem data-move-tier={to} onSelect={() => onMoveTier(to)}>
          {to === "critical" ? "Move to critical path" : "Move to polish"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepLine({ row, step, history, detail, days, dragging, onDragStart, onDragEnd, onMoveTier }: {
  row: PriorityRow;
  step: PriorityStep;
  history: PriorityHistory | undefined;
  detail: PriorityDetail | null | undefined;
  days: string[];
  dragging: boolean;
  onDragStart?: () => void;
  onDragEnd: () => void;
  onMoveTier?: (tier: PriorityStepTier) => void;
}) {
  const sessions = stepSessions(row, step, detail);
  const tasks = step.refs.filter((r) => r.kind === "task");
  const code = step.refs.filter((r) => r.kind === "pr" || r.kind === "commit");
  return (
    <li
      data-step={step.key}
      draggable={!!onDragStart}
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; onDragStart?.(); }}
      onDragEnd={onDragEnd}
      className={cn(STEP_GRID, "border-t border-sol-border/30 py-1.5 first:border-t-0", dragging && "opacity-40")}
    >
      <span aria-hidden className={cn("pt-1 text-sol-text-dim", onDragStart ? "cursor-grab" : "invisible")}><GripVertical className="size-3" /></span>
      <span
        aria-label={step.done ? "Done" : "Not done"}
        className={cn("mt-0.5 flex size-4 items-center justify-center rounded-full", step.done ? "bg-sol-green text-sol-bg" : "border-[1.5px] border-sol-border")}
      >
        {step.done && <Check className="size-2.5" strokeWidth={3} />}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1">
          <div className={cn("min-w-0 truncate text-ui font-medium", step.done ? "text-sol-text-muted" : "text-sol-text")} title={step.title}>{step.title}</div>
          {onMoveTier && <StepMenu step={step} onMoveTier={onMoveTier} />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {tasks.map((t) => <EntityIdPill key={t.id} shortId={t.id} type="task" />)}
          {sessions.slice(0, MAX_STEP_SESSIONS).map((s) => <EntityIdPill key={s.short_id} shortId={s.short_id} type="session" label={s.title || undefined} />)}
          {sessions.length > MAX_STEP_SESSIONS && <span className="text-meta text-sol-text-dim">+{sessions.length - MAX_STEP_SESSIONS}</span>}
          {code.map((c) => <EntityIdPill key={c.id} shortId={c.id} type={c.kind as "pr" | "commit"} certain />)}
          {stepNeedsSession(row, step, sessions, detail) && (
            <Link
              href={newSessionHref(row, step)}
              className="inline-flex items-center gap-1 rounded-control border border-dashed border-sol-border px-1.5 py-px text-meta text-sol-blue hover:border-sol-blue/50"
            >
              <Plus className="size-3" /> new session
            </Link>
          )}
        </div>
      </div>
      {days.length > 0 && <span className="hidden pt-1.5 [@container(min-width:36rem)]:block"><HistoryStrip days={days} counts={stepCounts(history, sessions)} size="step" /></span>}
    </li>
  );
}
