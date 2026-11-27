// The line under a Working, Shipping or Sleeping row that says what it is
// really doing (the shared sessionActivity, read over the store by
// lib/railActivity), and the conversation header's chip, which says the same.
//
//   Working   what its own work is: "3 subagents · reviewing", "running tests"
//   Shipping  neutral words and the change's five-segment bar
//             (Check, Review, Merge, Deploy, Live), ✕ only on a failed step
//   Sleeping  what wakes it: "waiting on" a person (coloured) or a session,
//             task or pull request (neutral), a trigger's countdown, or the
//             stalled line in the warning colour
//
// Colour is for attention only: reference pills on these lines are neutral,
// and only the person a row waits on, the stalled line and a failure keep a
// tone. Geometry: the ↳ sits in the card's status-mark column and the words
// start in its text column (the card's pl-3, a w-5 lead and gap-2), with
// arrow, words and pills on one vertical centre.
import type { ReactNode, MouseEvent } from "react";
import { X } from "lucide-react";
import type { SessionActivity } from "@codecast/shared/contracts/sessionActivity";
import Link from "next/link";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { shipActionHref } from "../../lib/railActivity";
import { EntityIdPill } from "../EntityIdPill";
import { Mark } from "../Mark";
import { ChangeTrack } from "../changes/ChangeChip";
import { CHANGE_STAGES, type Lifecycle, type StageState } from "../../lib/changes/lifecycle";
import { fmtDuration } from "../triggerCadence";
import type { TriggerRow } from "../triggerTasks";
import { DORMANT_CLAIM_TITLE, dormantWakeLabel } from "./dormantWake";
import { WakeWhen } from "./DormantWakeRows";
import { SessionStatusMark, SessionStatusWord } from "./SessionStatusMark";
import type { SessionStatus } from "../../lib/sessionStatus";
import "./activityLine.css";

export type RowActivity = SessionActivity<TriggerRow>;

const SHIP_STAGES = ["ci", "review", "merge", "deploy", "live"] as const;
const SHIP_LABEL = ["Check", "Review", "Merge", "Deploy", "Live"];

/** The PR pill's five-segment track (ChangeTrack), grey, the current segment filled; ✕ after it only on a failed step. */
export function ShipBar({ stage, failed }: { stage: (typeof SHIP_STAGES)[number]; failed: boolean }) {
  const at = SHIP_STAGES.indexOf(stage);
  const now: StageState = failed ? "failed" : "active";
  const lifecycle = {
    stages: CHANGE_STAGES.map((id, i) => ({ id, label: SHIP_LABEL[i], state: i < at ? "done" : i === at ? now : "idle", line: null, short: null })),
    now: { stage: CHANGE_STAGES[at], state: now },
  } as unknown as Lifecycle;
  return (
    <span className="chg-seg" data-tone="muted" data-ship-bar={stage} title={`${SHIP_LABEL.join(" · ")}: at ${SHIP_LABEL[at]}${failed ? ", failed" : ""}`}>
      <ChangeTrack lifecycle={lifecycle} />
      {failed ? <X className="chg-now" aria-hidden strokeWidth={3} /> : null}
    </span>
  );
}

const sinceWords = (since: number | null, now: number) => (since != null ? `since ${fmtDuration(Math.max(0, now - since))}` : null);

/** A reference the row waits on. Only a person keeps its colour: the rest are neutral, nothing to act on. */
/** A reference the row waits on (contracts/waitingOn). A session's ref is its
 *  conversation id, with its short id in `label` for the text until the pill
 *  resolves; a pull request's is "owner/repo#42"; a task's "ct-12"; a
 *  person's "@handle". Only a person keeps its colour: the rest are neutral,
 *  nothing to act on. */
function WaitPill({ kind, target: raw, label, session }: { kind: "person" | "session" | "task" | "pr"; target: string; label?: string; session: InboxSession }) {
  if (kind === "person") return <span data-ref-person className="al-pill"><EntityIdPill type="person" id={raw.replace(/^@/, "")} label={label ?? raw} fallback={label ?? raw} /></span>;
  let pill: ReactNode;
  if (kind === "pr") {
    const repo = session.pr_status?.repository;
    const ref = /^#\d+$/.test(raw) && repo ? `${repo}${raw}` : raw;
    const text = label ?? `#${ref.split("#").pop()}`;
    pill = <EntityIdPill shortId={ref} certain label={text} fallback={text} />;
  } else {
    pill = <EntityIdPill type={kind} id={raw} label={label ?? raw} fallback={label ?? raw} />;
  }
  return <span data-ref-neutral data-ref-kind={kind} className="al-pill">{pill}</span>;
}

const ALERT = (
  <svg viewBox="0 0 10 10" width={10} height={10} aria-hidden className="shrink-0">
    <path d="M5 1.1 9.3 8.7H.7z" fill="currentColor" />
    <path d="M5 4v2.2" stroke="var(--sol-bg-alt)" strokeWidth="1.1" strokeLinecap="round" />
    <circle cx="5" cy="7.4" r=".55" fill="var(--sol-bg-alt)" />
  </svg>
);

type ActivityParts = {
  /** The arrow's accessible name: what the line answers. */
  label: string;
  warn: boolean;
  body: ReactNode;
  right: ReactNode | null;
  title: string | null;
  /** A trigger's row, for a line that opens its schedule. */
  trigger: TriggerRow | null;
};

/** What a row's line says, shared by the rail's under-line and the header chip. */
function activityParts(activity: RowActivity, session: InboxSession, now: number, actionHref: string | null): ActivityParts {
  const parts = (p: Partial<ActivityParts> & Pick<ActivityParts, "label" | "body">): ActivityParts => ({ warn: false, right: null, title: null, trigger: null, ...p });
  if (activity.state === "working") return parts({ label: "What is running", body: <span className="truncate">{activity.words}</span>, title: activity.words });
  if (activity.state === "shipping") {
    // A step held for the viewer asks them to act: the attention colour, and
    // the words open where they act (the run's gate, the deploy). A hold on
    // someone else stays neutral.
    const mine = activity.holder === "you";
    const words = mine && actionHref
      ? <Link href={actionHref} data-ship-action className="truncate underline-offset-2 hover:underline">{activity.words}</Link>
      : <span className="truncate">{activity.words}</span>;
    return parts({
      label: mine ? "What the change waits on you for" : "Where the change is",
      warn: mine,
      body: <>{words}<ShipBar stage={activity.stage} failed={activity.failed} /></>,
      title: activity.words,
    });
  }
  if (activity.flavor === "waiting" && activity.on) {
    const { kind, ref } = activity.on;
    return parts({
      label: "What wakes this session",
      body: (
        <>
          <span className="shrink-0">waiting on</span>
          <WaitPill kind={kind} target={ref} label={activity.on.label} session={session} />
          {kind === "task" ? <span className="shrink-0">landing</span> : kind === "pr" ? <span className="shrink-0">to merge</span> : null}
        </>
      ),
      right: sinceWords(activity.since, now),
    });
  }
  if (activity.flavor === "stalled") {
    const back = activity.wake.back;
    return parts({
      label: "Nothing wakes this session",
      warn: true,
      body: <>{ALERT}<span className="truncate">nothing scheduled</span></>,
      right: back > now ? `back to you in ${fmtDuration(back - now)}` : "back to you now",
      title: [DORMANT_CLAIM_TITLE, activity.wake.what].filter(Boolean).join("\n"),
    });
  }
  // A trigger's countdown, a task wait the row cannot name, a park gone
  // quiet, the person's own filing: the dormant wake's own words.
  const wake = activity.wake!;
  const { what, when, warn } = dormantWakeLabel(wake, now);
  return parts({
    label: "What wakes this session",
    warn: !!warn,
    body: <span className="truncate">{what}</span>,
    right: <WakeWhen when={when} />,
    title: warn ?? what,
    trigger: wake.kind === "trigger" ? wake.row : null,
  });
}

/** The line's ↳: the registered "Inside this session" mark (lib/marks), in the card's mark column. */
function Arrow({ label, warn }: { label: string; warn: boolean }) {
  return (
    <Mark id="inbox.inside">
      <span data-al-arrow className={`flex h-[18px] w-5 shrink-0 items-center justify-center ${warn ? "text-sol-yellow/80" : "text-sol-text-dim/70"}`} role="img" aria-label={label}>
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
        </svg>
      </span>
    </Mark>
  );
}

/** Where a step held for the viewer sends them to act; read only while one is. */
const useShipAction = (activity: RowActivity, sessionId: string): string | null =>
  useInboxStore((st) => (activity.state === "shipping" && activity.holder === "you" ? shipActionHref(st, sessionId) : null));

const CHIP_STATUS = { working: "working", shipping: "shipping", sleeping: "dormant" } as const satisfies Record<RowActivity["state"], SessionStatus>;

/** The conversation header's chip: the row's state, its mark and word, then what its under-line says. Pressing a trigger's chip opens that trigger. */
export function ActivityChip({ session, activity, now, onOpenTrigger }: {
  session: InboxSession;
  activity: RowActivity;
  now: number;
  onOpenTrigger: (row: TriggerRow) => void;
}) {
  const { label, warn, body, right, title, trigger } = activityParts(activity, session, now, useShipAction(activity, session._id));
  const status = CHIP_STATUS[activity.state];
  const tone = warn ? "text-sol-yellow/90" : "text-sol-text-dim";
  const kind = activity.state === "sleeping" ? activity.flavor : activity.state;
  const inner = (
    <>
      <span className="flex shrink-0 items-center gap-1" aria-label={label}>
        <SessionStatusMark status={status} labeled />
        <SessionStatusWord status={status} className="font-medium" />
      </span>
      <span data-dormant-sep aria-hidden className="shrink-0 text-sol-text-dim">·</span>
      <span data-dormant-what className={`flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap ${tone}`}>{body}</span>
      {right != null && (
        <span className={`shrink-0 whitespace-nowrap tabular-nums ${tone}`}>
          <span data-dormant-sep>· </span>{right}
        </span>
      )}
    </>
  );
  const className = "flex items-center gap-1 min-w-[16rem] max-w-[28rem] shrink overflow-hidden text-meta";
  return trigger ? (
    <button type="button" data-dormant-wake={kind} data-activity-line={kind} onClick={() => onOpenTrigger(trigger)} title={title ?? undefined} className={`${className} rounded px-1 hover:bg-sol-blue/[0.08] transition-colors`}>
      {inner}
    </button>
  ) : (
    <span data-dormant-wake={kind} data-activity-line={kind} title={title ?? undefined} className={className}>
      {inner}
    </span>
  );
}

/** The rail's under-line. Pressing it opens the session (a trigger's line, its schedule); a pill opens what it names. */
export function ActivityUnderLine({ session, activity, now, isActive, onOpen, onOpenSchedule }: {
  session: InboxSession;
  activity: RowActivity;
  now: number;
  isActive: boolean;
  onOpen: (session: InboxSession) => void;
  onOpenSchedule: (row: TriggerRow) => void;
}) {
  const { label, warn, body, right, title, trigger } = activityParts(activity, session, now, useShipAction(activity, session._id));
  const tone = warn ? "text-sol-yellow/90" : "text-sol-text-dim";
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a,button")) return;
    if (trigger) onOpenSchedule({ ...trigger, openId: session._id } as TriggerRow);
    else onOpen(session);
  };
  return (
    <div
      data-cc-tech
      data-card-bar
      data-activity-line={activity.state === "sleeping" ? activity.flavor : activity.state}
      className={`relative transition-colors ${isActive ? "bg-sol-cyan/[0.10]" : ""}`}
    >
      <div
        role="button"
        tabIndex={-1}
        onClick={open}
        className="flex w-full cursor-pointer items-center gap-2 py-[3px] pl-3 pr-3 text-left text-meta leading-[18px] hover:bg-sol-blue/[0.05] transition-colors"
      >
        <Arrow label={label} warn={warn} />
        {/* The words carry the tooltip, so it never covers the arrow's own (its mark's name). */}
        <span title={title ?? undefined} className={`flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap ${tone}`}>{body}</span>
        {right != null && <span className={`ml-auto shrink-0 whitespace-nowrap tabular-nums ${tone}`}>{right}</span>}
      </div>
    </div>
  );
}
