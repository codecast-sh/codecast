import { planTierOf, type PlanGroup, type PlanTier, type RestingPlan } from "../../store/inboxStore";
import { PLAN_STATE_STATUS, SESSION_STATUS } from "../../lib/sessionStatus";
import { compactAge } from "../../lib/threadState";
import { ChevronDown } from "lucide-react";
import { SessionStatusMark } from "./SessionStatusMark";

// The "By plan" lens's pieces: each plan group's header mark and facts, and
// the plans with open work that nobody is on.

/** "4m", "2h", "3d", and "now" under a minute: sized for a column. */
const shortAge = (ms: number) => { const a = compactAge(ms); return a === "just now" ? "now" : a; };

/** A wait older than this reads as a dead ask: someone has to clear it. */
const STALE_ASK_MS = 7 * 24 * 3600_000;

// The plan's id ahead of its title. Its state mark shows only where the band
// above it does not already say it (the quiet band mixes states).
export function PlanGroupMark({ group }: { group: PlanGroup }) {
  const { status, word } = PLAN_STATE_STATUS[group.standing.state];
  return (
    <span title={word} className="flex shrink-0 items-center gap-1.5">
      {planTierOf(group.standing.state) === "quiet" && <SessionStatusMark status={status} />}
      <span className="font-mono text-meta font-normal text-sol-text-dim">{group.key}</span>
    </span>
  );
}

// Tasks done as a short bar and its numbers.
function TaskProgress({ done, total, column }: { done: number; total: number; column?: boolean }) {
  const pct = Math.round((Math.min(done, total) / total) * 100);
  return (
    <span title={`${done} of ${total} tasks done`} className="flex shrink-0 items-center gap-1">
      <span aria-hidden className="relative h-1 w-5 overflow-hidden rounded-full bg-sol-border">
        <span className={`absolute inset-y-0 left-0 rounded-full ${done >= total ? "bg-sol-green" : "bg-sol-text-dim"}`} style={{ width: `${pct}%` }} />
      </span>
      {/* In a list the numbers keep one column, so the bars line up. */}
      <span className={column ? "min-w-[7ch] text-right" : undefined}>{done}/{total}</span>
    </span>
  );
}

const TIER_META: Record<PlanTier, { status: Parameters<typeof SessionStatusMark>[0]["status"]; word: string }> = {
  needs_you: { status: "needs_you", word: "Waiting on you" },
  moving: { status: "working", word: "Moving" },
  parked: { status: "dormant", word: "Parked" },
  quiet: { status: "idle", word: "Quiet" },
};

// The band over a run of plans: its word, how many, and a toggle between
// their cards and a line each. Every band in the lens draws through this.
function PlanBand({ status, word, count, note, collapsed, onToggle, attrs }: {
  status: Parameters<typeof SessionStatusMark>[0]["status"];
  word: string;
  count: number;
  note?: string;
  collapsed: boolean;
  onToggle: () => void;
  attrs?: Record<string, string>;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      {...attrs}
      className={`flex w-full items-center gap-2 px-3 pt-3 pb-1 text-left ${SESSION_STATUS[status].text}`}
    >
      <SessionStatusMark status={status} />
      <span className="text-mark font-semibold uppercase tracking-[0.08em]">{word}</span>
      <span className="text-mark tabular-nums opacity-70">{count}</span>
      {note && <span className="text-mark text-sol-text-dim">{note}</span>}
      <span aria-hidden className="h-px min-w-4 flex-1 bg-current opacity-20" />
      <ChevronDown aria-hidden className={`h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-transform ${collapsed ? "-rotate-90" : ""}`} />
    </button>
  );
}

export function PlanTierHeader({ tier, count, collapsed, onToggle }: { tier: PlanTier; count: number; collapsed: boolean; onToggle: () => void }) {
  const { status, word } = TIER_META[tier];
  return <PlanBand status={status} word={word} count={count} collapsed={collapsed} onToggle={onToggle} attrs={{ "data-inbox-plan-tier": tier }} />;
}

// One plan on one line: its id, title, tasks done and how long ago it moved.
// A folded band lists its plans this way, and so does "Nobody on it".
export function CompactPlanRow({ id, title, progress, movedAt, now, status, active, onClick }: {
  id: string;
  title: string;
  progress?: { done?: number; total?: number } | null;
  movedAt: number | null;
  now: number;
  /** A state mark, for a list that mixes states. */
  status?: Parameters<typeof SessionStatusMark>[0]["status"];
  /** One of the plan's threads is the one open. */
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-inbox-plan-row={id}
      aria-current={active || undefined}
      className={`flex w-full items-center gap-2 border-b border-l-2 border-b-sol-border/30 px-3 py-1.5 text-left ${active ? "border-l-sol-cyan bg-sol-cyan/[0.06]" : "border-l-transparent hover:bg-sol-bg-alt/60"}`}
    >
      <span className="flex w-2 shrink-0">{status && <SessionStatusMark status={status} size={8} />}</span>
      <span className="w-[7.5ch] shrink-0 font-mono text-meta text-sol-text-dim">{id}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-sol-text">{title}</span>
      <span className="flex shrink-0 items-center gap-2 font-mono text-meta tabular-nums text-sol-text-dim">
        {progress?.total ? <TaskProgress done={progress.done ?? 0} total={progress.total} column /> : null}
        <span title="Last moved" className="w-[3.5ch] text-right">{movedAt !== null ? shortAge(now - movedAt) : ""}</span>
      </span>
    </button>
  );
}

// The plan's tasks done, after its title. The owner is not repeated here:
// the group's first card is the lead thread, and it already names its role.
export function PlanGroupFacts({ group }: { group: PlanGroup }) {
  const progress = group.plan?.progress;
  if (!progress?.total) return null;
  return (
    <span className="ml-1 flex shrink-0 items-center font-mono text-meta tabular-nums text-sol-text-dim">
      <TaskProgress done={progress.done ?? 0} total={progress.total} />
    </span>
  );
}

// How long the plan's oldest ask has waited, as the button that opens it: the
// asking thread may be a worker nested under the lead and out of sight.
export function PlanAskButton({ group, now, onOpen }: { group: PlanGroup; now: number; onOpen: (id: string) => void }) {
  const { asks, askedAt } = group.standing;
  if (askedAt === null || !asks.length) return null;
  const age = now - askedAt;
  return (
    <button
      type="button"
      onClick={() => onOpen(asks[0])}
      title={`Open the oldest of ${asks.length} waiting on you (${shortAge(age)})`}
      className={`flex items-center gap-1 rounded-control px-1.5 py-0.5 font-mono text-meta tabular-nums hover:bg-sol-bg-alt ${age > STALE_ASK_MS ? "font-semibold text-sol-red" : SESSION_STATUS.needs_you.text}`}
    >
      <SessionStatusMark status="needs_you" size={8} />
      {asks.length > 1 ? `${asks.length} · ` : ""}{shortAge(age)}
    </button>
  );
}

export function RestingPlans({
  plans,
  collapsed,
  onToggle,
  onOpen,
  now,
}: {
  plans: RestingPlan[];
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (plan: RestingPlan["plan"]) => void;
  now: number;
}) {
  if (plans.length === 0) return null;
  const stalled = plans.filter((p) => p.state === "stalled").length;
  return (
    <div data-inbox-resting-plans>
      <PlanBand
        status="idle"
        word="Nobody on it"
        count={plans.length}
        note={stalled < plans.length ? `· ${plans.length - stalled} finished` : undefined}
        collapsed={collapsed}
        onToggle={onToggle}
        attrs={{ "data-inbox-section": "plan_resting" }}
      />
      {!collapsed && plans.map(({ plan, state }) => (
        <CompactPlanRow
          key={plan._id}
          id={plan.short_id}
          title={plan.title}
          progress={plan.progress}
          movedAt={plan.updated_at ?? null}
          now={now}
          // Every row here is stalled unless it says otherwise.
          status={state === "finished" ? PLAN_STATE_STATUS.finished.status : undefined}
          onClick={() => onOpen(plan)}
        />
      ))}
    </div>
  );
}
