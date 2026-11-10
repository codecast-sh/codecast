import type React from "react";
import type { InboxSession } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useLiveWatchRows } from "../../hooks/useLiveWatchRows";
import { threadStateView } from "../../lib/threadState";
import { WAKE_BADGE } from "../../lib/triggerBadges";
import { fmtClock, fmtDuration } from "../triggerCadence";
import { taskDisplayTitle, type TriggerRow } from "../triggerTasks";
import { SchedChildArrow, SchedFireBadge } from "../TriggerRow";
import { dormantWakeOf } from "./dormantWake";

// -- Wake rows --
// DormantWakeRow: every card in the DORMANT section carries one line saying
// what wakes it and when (dormantWakeOf), whatever the card-bar mode, because
// a parked card is only safe to ignore when its wake is visible. Nothing
// verifiable scheduled reads as a claim with the time it returns to the person.
//
// DormantClaimRow is the inverse, for a card filed under NEEDS INPUT whose
// pinned state still declares dormant: the agent SAYS a machine wakes it, but
// the system can verify no armed trigger, watch, loop or run (the wake already
// landed and the agent never re-declared, the wake lives somewhere the daemon
// cannot see, or the bare claim outlived DORMANT_CLAIM_TTL_MS). The row names
// the claim and marks it unverified, so the card explains why it still asks.
export function DormantWakeRow({ session, rows, isActive, onOpen, onOpenSchedule }: {
  session: InboxSession;
  rows: TriggerRow[];
  isActive: boolean;
  onOpen: (session: InboxSession) => void;
  onOpenSchedule: (row: TriggerRow) => void;
}) {
  const now = useCoarseNow(30_000);
  const watches = useLiveWatchRows(session, now);
  const wake = dormantWakeOf(session, rows, watches, now);
  let what: string;
  let when: React.ReactNode;
  let warn = false;
  switch (wake.kind) {
    case "trigger":
      what = taskDisplayTitle(wake.row.task) + (wake.others > 0 ? ` +${wake.others}` : "");
      when = <SchedFireBadge task={wake.row.task} />;
      break;
    case "trigger_unloaded":
      what = "a trigger fires into it";
      when = "armed";
      break;
    case "workflow":
      what = `workflow: ${wake.name}`;
      when = "when it finishes";
      break;
    case "background":
      what = `${wake.count > 1 ? `${wake.count} background tasks` : "background task"}${wake.what ? `: ${wake.what}` : ""}`;
      when = "when it finishes";
      break;
    case "workers":
      what = "its subagents are still working";
      when = "when they finish";
      break;
    case "snoozed":
      what = "snoozed";
      when = fmtClock(wake.at, now);
      break;
    case "parked":
      what = "parked by you";
      when = "on next activity";
      break;
    case "claim":
      warn = true;
      what = wake.what ? `nothing scheduled · ${wake.what}` : "nothing scheduled";
      when = wake.back > now ? `yours in ${fmtDuration(wake.back - now)}` : "yours now";
      break;
  }
  return (
    <div data-cc-tech data-card-bar data-dormant-wake={wake.kind} className={`relative transition-colors ${isActive ? "bg-sol-cyan/[0.10]" : ""}`}>
      <button
        className="w-full flex items-center gap-1.5 text-left cursor-pointer pl-2 pr-3 py-[3px] hover:bg-sol-blue/[0.05] transition-colors"
        onClick={() => (wake.kind === "trigger" ? onOpenSchedule(wake.row) : onOpen(session))}
        title={wake.kind === "claim" ? "The agent named a wake nothing here can see. It returns to Needs Input if nothing happens." : "Open"}
      >
        <SchedChildArrow label="What wakes this session" className="text-sol-text-dim/70" />
        <span className={`text-meta truncate min-w-0 ${warn ? "text-sol-yellow/90" : "text-sol-text-dim"}`}>{what}</span>
        <span className={`ml-auto shrink-0 whitespace-nowrap text-meta tabular-nums ${warn ? "text-sol-yellow/90" : "text-sol-text-dim"}`}>{when}</span>
      </button>
    </div>
  );
}

export function DormantClaimRow({ session, isActive, hasOtherRows, onOpen }: {
  session: InboxSession;
  isActive: boolean;
  hasOtherRows: boolean;
  onOpen: (session: InboxSession) => void;
}) {
  const now = useCoarseNow(30_000);
  const watchRows = useLiveWatchRows(session, now).length;
  if (hasOtherRows || watchRows > 0) return null;
  const ts = threadStateView(session, session.message_count ?? 0, now);
  // Only a state that still DECLARES dormant earns the row; a stale state
  // reads as absent (threadStateView returns null), and any other declared
  // status means no wake was claimed.
  if (ts?.status !== "dormant") return null;
  return (
    <WakeReasonRowShell
      isActive={isActive}
      family="Wake"
      title="state claims a machine wake"
      detail={`no armed trigger, watch, or loop · ${ts.provenance}`}
      badge="unverified"
      badgeClass="bg-sol-yellow/10 text-sol-yellow border-sol-yellow/30"
      onClick={() => onOpen(session)}
    />
  );
}

// The one row anatomy both wake-reason variants wear, on one line like the
// folded trigger strip: ↳ child glyph, family eyebrow, title, detail, optional
// badge, so a card's children always read as one family. The badge slot means one thing on every child row: the state of
// the WAKE (a trigger's countdown, a command "running", a claim "unverified").
// The plain reason row has no wake to report, so it carries no badge — the
// card's section already says the session is parked.
function WakeReasonRowShell({ isActive, family, title, detail, badge, badgeClass, onClick }: {
  isActive: boolean;
  family: string;
  title: string;
  detail: string;
  badge?: string;
  badgeClass?: string;
  onClick: () => void;
}) {
  const ariaLabel = `${family} — why this session is parked`;
  return (
    <div data-cc-tech data-card-bar className={`group/dormrow relative transition-colors ${isActive ? "bg-sol-cyan/[0.10]" : ""}`}>
      <button
        className="w-full text-left cursor-pointer pr-3 pl-2 py-1 hover:bg-sol-blue/[0.05] transition-colors"
        onClick={onClick}
        title="Open the session"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex items-center shrink-0 text-sol-blue/70" role="img" aria-label={ariaLabel}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <title>{ariaLabel}</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
            </svg>
          </span>
          {/* One line, in the folded strip's type: family, what it waits on,
              where that came from, and the wake's state when it has one. */}
          <div className="min-w-0 flex-1 flex items-center gap-1.5">
            <span className="text-mark font-semibold uppercase tracking-wider text-sol-blue/70 shrink-0">{family}</span>
            {title && <span className="text-meta truncate min-w-0 text-sol-text-muted font-normal">{title}</span>}
            {detail && <span className="text-meta truncate min-w-0 text-sol-text-dim">{title ? "· " : ""}{detail}</span>}
            {badge && (
              <span data-sv-wake-badge="" className={`ml-auto ${WAKE_BADGE} ${badgeClass ?? ""}`}>
                {badge}
              </span>
            )}
          </div>
        </div>
      </button>
    </div>
  );
}
