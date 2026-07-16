"use client";

// Past runs of one schedule, as a clickable list — every entry lands the user
// on the MESSAGE that triggered that run (the `<scheduled-task>` turn for
// inject schedules, the opening prompt for spawned runs). One component +
// one data hook shared by every surface that shows a schedule (the /schedules
// page rows, the conversation strip, the inbox schedule dock) so the payload
// shape and the "click a run → land on its trigger" behavior can't drift.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { ArrowUpRight } from "lucide-react";
import { fmtDuration } from "./scheduleCadence";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { useInboxStore } from "../store/inboxStore";

const api = _api as any;

// agentTasks.webListRuns payload. `_id` is the conversation a run lives in
// (inject runs share their schedule's home conversation); `run_key` is unique
// per run; `trigger_message_id` is the message that fired it.
export type ScheduleRun = {
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
export function useScheduleRuns(taskId: string | null | undefined): ScheduleRun[] | undefined {
  return useQuery(api.agentTasks.webListRuns, taskId ? { task_id: taskId } : "skip") as
    | ScheduleRun[]
    | undefined;
}

// Full-page href for a run — used where in-app store navigation isn't mounted
// (the /schedules route). The #msg- hash pages the conversation in around the
// trigger and scrolls to it.
export function runHref(run: ScheduleRun): string {
  return `/conversation/${run._id}${run.trigger_message_id ? `#msg-${run.trigger_message_id}` : ""}`;
}

// In-app navigation to a run's trigger message — used inside the inbox shell
// (strip, dock). requestNavigate handles cached, dismissed/folded, and
// not-yet-synced conversations uniformly (same path as bookmarks/search).
export function openRunInStore(run: ScheduleRun) {
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

export function ScheduleRunList({
  runs,
  now,
  mode,
  currentConversationId,
  onOpened,
  className,
}: {
  runs: ScheduleRun[];
  now: number;
  // "link" renders full-page <Link>s (the /schedules route); "store" navigates
  // through the inbox store (strip, dock).
  mode: "link" | "store";
  // Marks runs living in the conversation the user is already viewing — they
  // still click (scroll to the trigger), the chip just says where they are.
  currentConversationId?: string | null;
  // Called after a store-mode navigation, so overlays (the dock roster) close.
  onOpened?: () => void;
  className?: string;
}) {
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
          const label = run.idle_summary || run.title;
          const inner = (
            <>
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
            </>
          );
          const tip = run.trigger_message_id
            ? "Open the message that triggered this run"
            : "Open this run's session";
          return mode === "link" ? (
            <ShortcutTooltip key={run.run_key} label={tip}>
              <Link href={runHref(run)} onClick={(e) => e.stopPropagation()} className={rowCls}>
                {inner}
              </Link>
            </ShortcutTooltip>
          ) : (
            <ShortcutTooltip key={run.run_key} label={tip}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openRunInStore(run);
                  onOpened?.();
                }}
                className={rowCls}
              >
                {inner}
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
