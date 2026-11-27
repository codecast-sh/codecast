import type { InboxSession } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useLiveWatchRows } from "../../hooks/useLiveWatchRows";
import { threadStateView } from "../../lib/threadState";
import { rowPinPredatesTurn, rowVerifiedWake } from "@codecast/shared/contracts/inboxPlacement";
import { WAKE_BADGE } from "../../lib/triggerBadges";
import type { TriggerRow } from "../triggerTasks";
import { SchedChildArrow, SchedFireBadge } from "../TriggerRow";
import { useDormantWake } from "../../hooks/useDormantWake";
import { dormantWakeLabel, isLivePark, serverParkOf, type DormantWakeLabel } from "./dormantWake";

export function WakeWhen({ when }: { when: DormantWakeLabel["when"] }) {
  return typeof when === "string" ? <>{when}</> : <SchedFireBadge task={when.task} />;
}

// -- Wake rows --
// DormantWakeRow: every card in the DORMANT section carries one line saying
// what wakes it and when (dormantWakeOf), whatever the card-bar mode, because
// a parked card is only safe to ignore when its wake is visible. Nothing
// verifiable scheduled reads as a claim with the time it returns to the person.
//
// DormantClaimRow is the inverse, for a card filed under NEEDS INPUT whose
// pinned state still declares dormant: the agent SAYS a machine wakes it, but
// the system verifies no wake (rowVerifiedWake: the wake already
// landed and the agent never re-declared, the wake lives somewhere the daemon
// cannot see, or the bare claim outlived DORMANT_CLAIM_TTL_MS). The row names
// the claim and marks it unverified, so the card explains why it still asks.
// A park the server saw and the classifier dropped (a wait or run quiet past
// its trust, a run while its session's daemon is not reporting) is named even when the
// pin itself is too old to show (its stamp outlives the pin's 48h), and a pin
// older than the session's last turn says so: that, not the wake, is why it
// asks.
export function DormantWakeRow({ session, rows, isActive, onOpen, onOpenSchedule }: {
  session: InboxSession;
  rows: TriggerRow[];
  isActive: boolean;
  onOpen: (session: InboxSession) => void;
  onOpenSchedule: (row: TriggerRow) => void;
}) {
  const { wake, label: { what, when, warn } } = useDormantWake(session, rows);
  return (
    <div data-cc-tech data-card-bar data-dormant-wake={wake.kind} className={`relative transition-colors ${isActive ? "bg-sol-cyan/[0.10]" : ""}`}>
      <button
        className="w-full flex items-center gap-1.5 text-left cursor-pointer pl-2 pr-3 py-[3px] hover:bg-sol-blue/[0.05] transition-colors"
        onClick={() => (wake.kind === "trigger" ? onOpenSchedule(wake.row) : onOpen(session))}
      >
        <SchedChildArrow slot label="What wakes this session" className="text-sol-text-dim/70" />
        <span className={`text-meta truncate min-w-0 ${warn ? "text-sol-yellow/90" : "text-sol-text-dim"}`}>{what}</span>
        <span className={`ml-auto shrink-0 whitespace-nowrap text-meta tabular-nums ${warn ? "text-sol-yellow/90" : "text-sol-text-dim"}`}><WakeWhen when={when} /></span>
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
  // Only a pin that still DECLARES dormant earns the row; any other declared
  // status means no wake was claimed. A stale pin (threadStateView returns
  // null) earns it only through a server park it still names.
  if (session.thread_state_status !== "dormant") return null;
  const ts = threadStateView(session, session.message_count ?? 0, now);
  const park = serverParkOf(session, now);
  if (!ts && !park) return null;
  const outdated = rowPinPredatesTurn(session);
  // A wake the classifier verifies (rowVerifiedWake: a trigger, a loop, a
  // producing child, open background work, a live park) under a current pin
  // is not why the card asks: it is in Needs You for something else (a
  // decision, a banner, queued work, the person's filing), and this row would
  // blame the wrong thing. The text names what the same facts say.
  const liveWake = rowVerifiedWake({ ...session, updated_at: session.updated_at ?? 0 }, now);
  if (liveWake && !outdated) return null;
  const why = isLivePark(park) ? dormantWakeLabel(park!, now).what
    : liveWake ? "a wake the system sees still stands"
    : park ? dormantWakeLabel(park, now).what
    : "no trigger, watch, loop, background work, task, wait or run";
  return (
    <WakeReasonRowShell
      isActive={isActive}
      family="Wake"
      title={outdated ? "state is older than the session's last turn" : "state claims a machine wake"}
      detail={[why, ts?.provenance].filter(Boolean).join(" · ")}
      badge={outdated ? "outdated" : "unverified"}
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
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <SchedChildArrow slot label={ariaLabel} className="text-sol-blue/70" />
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
