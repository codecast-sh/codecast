import type { PlanGroup, RestingPlan } from "../../store/inboxStore";
import { PLAN_STATE_STATUS, SESSION_STATUS } from "../../lib/sessionStatus";
import { compactAge } from "../../lib/threadState";
import { SessionStatusMark } from "./SessionStatusMark";

// The "By plan" lens's pieces: each plan group's header mark and facts, and
// the plans with open work that nobody is on.

/** A wait older than this reads as a dead ask: someone has to clear it. */
const STALE_ASK_MS = 7 * 24 * 3600_000;

export function PlanGroupMark({ group }: { group: PlanGroup }) {
  const { status, word } = PLAN_STATE_STATUS[group.standing.state];
  return (
    <span title={word} className="flex">
      <SessionStatusMark status={status} />
    </span>
  );
}

// The owner is not repeated here: the group's first card is the lead thread,
// and it already names its role.
export function PlanGroupFacts({ group, now }: { group: PlanGroup; now: number }) {
  const { standing, plan } = group;
  const progress = plan?.progress;
  const askAge = standing.askedAt !== null ? now - standing.askedAt : null;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-2 font-mono text-meta tabular-nums text-sol-text-dim">
      {askAge !== null && (
        <span
          title={`${standing.asks.length} waiting on a person, the oldest for ${compactAge(askAge)}`}
          className={`flex shrink-0 items-center gap-1 ${askAge > STALE_ASK_MS ? "text-sol-red font-semibold" : SESSION_STATUS.needs_you.text}`}
        >
          <SessionStatusMark status="needs_you" size={8} />
          {standing.asks.length > 1 ? `${standing.asks.length} · ` : ""}{compactAge(askAge)}
        </span>
      )}
      {progress?.total ? <span title="Tasks done" className="shrink-0">{progress.done}/{progress.total}</span> : null}
    </span>
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
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        data-inbox-section="plan_resting"
        className="sticky top-0 z-10 flex h-8 w-full items-center gap-2 bg-sol-bg-alt px-3 text-left"
      >
        <SessionStatusMark status="idle" />
        <span className="text-mark font-semibold uppercase tracking-[0.08em] text-sol-text-muted">Nobody on it</span>
        <span className="text-mark tabular-nums text-sol-text-dim">{plans.length}</span>
        {stalled < plans.length && <span className="text-mark text-sol-text-dim">· {plans.length - stalled} finished</span>}
        <span aria-hidden className="h-px min-w-4 flex-1 bg-sol-border" />
      </button>
      {!collapsed && plans.map(({ plan, state }) => (
        <button
          key={plan._id}
          type="button"
          onClick={() => onOpen(plan)}
          className="flex w-full items-center gap-2 border-b border-sol-border/30 px-3 py-1.5 text-left hover:bg-sol-bg-alt/60"
        >
          <SessionStatusMark status={PLAN_STATE_STATUS[state].status} size={8} />
          <span className="shrink-0 font-mono text-meta text-sol-text-dim">{plan.short_id}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-sol-text">{plan.title}</span>
          <span className="shrink-0 font-mono text-meta tabular-nums text-sol-text-dim">
            {plan.progress?.done}/{plan.progress?.total} · {compactAge(now - (plan.updated_at ?? 0))}
          </span>
        </button>
      ))}
    </div>
  );
}
