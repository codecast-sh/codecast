"use client";

// Past runs of one schedule, as a clickable list — every entry lands the user
// on the MESSAGE that triggered that run (the `<scheduled-task>` turn for
// inject schedules, the opening prompt for spawned runs). One component +
// one data hook shared by every surface that shows a schedule (the /schedules
// page rows, the conversation strip, the inbox schedule dock) so the payload
// shape and the "click a run → land on its trigger" behavior can't drift.
//
// Navigation is store-driven everywhere (requestNavigate): the conversation
// switch and the scroll-to-trigger target are paired atomically, and the inbox
// shell resolves cached, dismissed/folded, and unsynced runs alike — the same
// path bookmarks and search hits ride. A plain /conversation/#msg- href is
// NOT used here: that full-page redirect re-enters the tab shell, whose ?s=
// re-assert can eat the scroll target (verified racing during this build).

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { ArrowUpRight } from "lucide-react";
import { fmtClock, fmtDuration } from "./triggerCadence";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { useInboxStore } from "../store/inboxStore";

const api = _api as any;

// agentTasks.webListRuns payload. `_id` is the conversation a run lives in
// (inject runs share their schedule's home conversation); `run_key` is unique
// per run; `trigger_message_id` is the message that fired it.
export type TriggerRun = {
  _id: string;
  run_key: string;
  kind: "spawn" | "inject";
  short_id?: string;
  title: string;
  created_at: number;
  status?: string;
  idle_summary?: string;
  trigger_message_id?: string;
  trigger_message_timestamp?: number;
};

// Subscribe to a schedule's run history. Pass null/undefined to skip (e.g.
// while the surface is collapsed) so closed rows cost no query.
export function useTriggerRuns(taskId: string | null | undefined): TriggerRun[] | undefined {
  return useQuery(api.agentTasks.webListRuns, taskId ? { task_id: taskId } : "skip") as
    | TriggerRun[]
    | undefined;
}

// Navigate to a run's trigger message through the store's atomic deep-link
// channel. Shared by the run list below and the strip's run chips.
export function openRunInStore(run: TriggerRun) {
  useInboxStore.getState().requestNavigate(
    run._id,
    run.trigger_message_id
      ? {
          scrollToMessageId: run.trigger_message_id,
          scrollToMessageTimestamp: run.trigger_message_timestamp,
        }
      : undefined,
  );
}

const PAGE = 8;

// Compact age for rail labels: the leading unit only ("22h", not "22h 3m").
export function shortAgo(ms: number): string {
  return fmtDuration(Math.max(0, ms)).split(" ")[0];
}

// Resting run-dot fill: mixed toward the card surface (not an alpha tint) so
// the timeline's connector line doesn't show through the dot it passes under.
const DOT_RESTING = "bg-[color-mix(in_srgb,var(--sol-orange)_55%,var(--sol-card))]";

export function TriggerRunList({
  runs,
  now,
  currentConversationId,
  onOpened,
  ensureInboxRoute,
  className,
}: {
  runs: TriggerRun[];
  now: number;
  // Marks runs living in the conversation the user is already viewing — they
  // still click (scroll to the trigger), the chip just says where they are.
  currentConversationId?: string | null;
  // Called after navigation, so overlays (the dock roster) close.
  onOpened?: () => void;
  // Set on surfaces OUTSIDE the inbox route (the /schedules page): nothing
  // there consumes requestNavigate, so after priming the store we route to
  // the inbox — its watchers pick up the parked target + scroll pair intact.
  ensureInboxRoute?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [limit, setLimit] = useState(PAGE);
  if (runs.length === 0) return null;
  const visible = runs.slice(0, limit);

  return (
    <div className={className}>
      {/* Vertical timeline: a spine joins the run dots into one history,
          fading toward the older end so the eye lands on the newest run. */}
      <div className="relative flex flex-col">
        <span
          aria-hidden
          className="absolute left-2 top-3 bottom-3 w-px -translate-x-1/2 bg-gradient-to-b from-sol-orange/50 via-sol-orange/15 to-transparent"
        />
        {visible.map((run, i) => {
          const num = runs.length - i;
          const latest = i === 0;
          // Inject runs all live in the home conversation — flagging each of
          // them "this session" would stamp every row. Only a spawned run is
          // distinctly the session being viewed.
          const here = run.kind === "spawn" && run._id === currentConversationId;
          // Inject runs all live in one conversation, so its title would just
          // repeat down the list — the fire time is the informative label.
          // Spawned runs are distinct sessions worth naming.
          const label = run.kind === "inject" ? fmtClock(run.created_at) : run.idle_summary || run.title;
          const tip = run.trigger_message_id
            ? "Open the message that triggered this run"
            : "Open this run's session";
          return (
            <ShortcutTooltip key={run.run_key} label={tip}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openRunInStore(run);
                  if (ensureInboxRoute) router.push(`/inbox?s=${run._id}`);
                  onOpened?.();
                }}
                className="group/run relative flex items-center gap-2 w-full min-w-0 rounded-md py-1 pr-1.5 text-left text-[11px] hover:bg-sol-cyan/10 transition-colors"
              >
                {/* Fixed-height dot slot keeps every center on the spine even
                    though the latest dot is a size up. */}
                <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                  <span
                    className={`rounded-full transition-[transform,background-color] duration-100 group-hover/run:scale-125 ${
                      latest
                        ? "w-2 h-2 bg-sol-orange shadow-[0_0_0_3px] shadow-sol-orange/15"
                        : `w-[7px] h-[7px] ${DOT_RESTING} group-hover/run:bg-sol-orange`
                    }`}
                  />
                </span>
                <span
                  className={`shrink-0 w-7 font-mono text-[10px] tabular-nums ${
                    latest ? "text-sol-text-muted" : "text-sol-text-dim"
                  }`}
                >
                  #{num}
                </span>
                <ShortcutTooltip label={new Date(run.created_at).toLocaleString()}>
                  <span className="shrink-0 w-[4.75rem] text-[10px] text-sol-text-dim tabular-nums">
                    {fmtDuration(Math.max(0, now - run.created_at))} ago
                  </span>
                </ShortcutTooltip>
                <span
                  className={`truncate min-w-0 transition-colors group-hover/run:text-sol-text ${
                    latest ? "text-sol-text" : "text-sol-text-muted"
                  }`}
                >
                  {label}
                </span>
                {here && (
                  <span className="shrink-0 px-1 rounded border border-sol-orange/40 bg-sol-orange/10 text-[9px] text-sol-orange">
                    this session
                  </span>
                )}
                <ArrowUpRight className="w-3 h-3 shrink-0 ml-auto text-sol-cyan opacity-0 group-hover/run:opacity-100 transition-opacity" />
              </button>
            </ShortcutTooltip>
          );
        })}
      </div>
      {runs.length > limit && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setLimit((l) => l + PAGE);
          }}
          className="text-[10px] text-sol-cyan hover:underline underline-offset-2 mt-0.5 pl-6"
        >
          show {Math.min(PAGE, runs.length - limit)} more · {runs.length - limit} older
        </button>
      )}
    </div>
  );
}

// Horizontal run rail for the conversation header strip: the same history as
// connected dots reading future → past, left to right — a hollow pulsing node
// for the next fire (when armed), a "now" tick, then every past run newest
// first. One text line tall — the header can't afford stacked label rows, so
// each node is dot + age side by side and the run number and exact fire time
// live in the tooltip. Each run node rides the same openRunInStore deep-link
// as the list.
export function TriggerRunRail({
  runs,
  now,
  conversationId,
  nextRunAt,
  className,
}: {
  runs: TriggerRun[];
  now: number;
  // The conversation being viewed — its own spawned run gets the ringed dot.
  conversationId: string;
  // Set only while the trigger is armed; renders the hollow "next" node.
  nextRunAt?: number;
  className?: string;
}) {
  if (runs.length === 0) return null;
  const msToNext = nextRunAt !== undefined ? nextRunAt - now : undefined;
  return (
    <div className={`flex items-center gap-2 min-w-0 ${className ?? ""}`}>
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-sol-text-dim">
        {runs.length} run{runs.length === 1 ? "" : "s"}
      </span>
      <div className="flex items-center min-w-0 overflow-x-auto">
        {msToNext !== undefined && (
          <>
            <ShortcutTooltip label={`Next fire at ${fmtClock(nextRunAt!)}`}>
              <span className="flex items-center gap-[3px] px-1 shrink-0 cursor-default">
                <span className="w-2 h-2 rounded-full border-[1.5px] border-sol-orange bg-sol-bg animate-pulse motion-reduce:animate-none" />
                <span className="text-[9px] leading-none text-sol-orange tabular-nums whitespace-nowrap">
                  {msToNext > 0 ? shortAgo(msToNext) : "due"}
                </span>
              </span>
            </ShortcutTooltip>
            {/* "Now" tick: future to its left, history to its right. */}
            <span aria-hidden className="shrink-0 w-px h-3 mx-0.5 bg-sol-cyan/50" />
          </>
        )}
        {runs.map((r, i) => {
          // Inject runs all share the home conversation, so only a spawned
          // run can claim "this is the session you're looking at".
          const here = r.kind === "spawn" && r._id === conversationId;
          const num = runs.length - i;
          const tooltip =
            r.kind === "inject"
              ? `#${num} · fired ${fmtClock(r.created_at)}`
              : r.idle_summary
                ? `#${num} · ${r.title} — ${r.idle_summary}`
                : `#${num} · ${r.title}`;
          const hint = here
            ? "this session — jump to the trigger"
            : r.trigger_message_id
              ? "open the trigger message"
              : undefined;
          return (
            <Fragment key={r.run_key}>
              {/* Connector stub between nodes — keeps the dots reading as one
                  timeline without a line striking through the age labels. */}
              {i > 0 && <span aria-hidden className="shrink-0 w-2 h-px bg-sol-orange/25" />}
              <ShortcutTooltip label={tooltip} hint={hint}>
                <button
                  onClick={() => openRunInStore(r)}
                  className="group/node flex items-center gap-[3px] px-1 py-0.5 rounded shrink-0 hover:bg-sol-orange/10 transition-colors"
                >
                  <span
                    className={`rounded-full transition-[transform,background-color] duration-100 group-hover/node:scale-125 ${
                      here
                        ? "w-2 h-2 bg-sol-orange shadow-[0_0_0_2px] shadow-sol-orange/20"
                        : i === 0
                          ? "w-2 h-2 bg-sol-orange"
                          : `w-[7px] h-[7px] ${DOT_RESTING} group-hover/node:bg-sol-orange`
                    }`}
                  />
                  <span
                    className={`text-[9px] leading-none tabular-nums whitespace-nowrap ${
                      here ? "font-semibold text-sol-orange" : "text-sol-text-dim"
                    }`}
                  >
                    {shortAgo(now - r.created_at)}
                  </span>
                </button>
              </ShortcutTooltip>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
