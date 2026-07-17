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

import { useState } from "react";
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

  const rowCls =
    "group/run flex items-center gap-2 w-full min-w-0 rounded px-1.5 py-1 text-left text-[11px] hover:bg-sol-cyan/10 transition-colors";

  return (
    <div className={className}>
      <div className="flex flex-col gap-px">
        {visible.map((run, i) => {
          const num = runs.length - i;
          const here = run._id === currentConversationId;
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
                className={rowCls}
              >
                <span className="shrink-0 font-mono text-[10px] text-sol-text-dim tabular-nums w-7 text-right">
                  #{num}
                </span>
                <ShortcutTooltip label={new Date(run.created_at).toLocaleString()}>
                  <span className="shrink-0 text-sol-text-dim tabular-nums">
                    {fmtDuration(Math.max(0, now - run.created_at))} ago
                  </span>
                </ShortcutTooltip>
                <span className="truncate min-w-0 text-sol-text-muted group-hover/run:text-sol-text transition-colors">
                  {label}
                </span>
                {here && (
                  <span className="shrink-0 px-1 rounded border border-sol-border/60 text-[9px] text-sol-text-dim">
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
          className="text-[10px] text-sol-cyan hover:underline underline-offset-2 mt-0.5 pl-1.5"
        >
          show {Math.min(PAGE, runs.length - limit)} more · {runs.length - limit} older
        </button>
      )}
    </div>
  );
}
