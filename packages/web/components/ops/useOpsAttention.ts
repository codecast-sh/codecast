// What is wrong right now (opsHomeModel attentionItems), from the store, for
// every surface that counts it: the sidebar badge, the Overview tab's count,
// the home's strip and its list. They all read this one hook with the one
// source health reading (useSourceHealthMap), on the same coarse clock, so one
// moment reads one number everywhere.
import { useMemo } from "react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { OPS_LIST_LIMIT, useOpsEvents, useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches } from "../../hooks/useSyncOps";
import { failuresIn } from "./issuesModel";
import { useInboxStore } from "../../store/inboxStore";
import { attentionItems, type AttentionInput, type AttentionItem, type AttentionTask } from "./opsHomeModel";
import type { SourceHealth } from "./sourceHealth";
import type { OpsGroup } from "./opsTypes";
import { splitSnoozed, type OpsSnoozes } from "./opsSnooze";

/** The clock every attention count runs on (a shared useCoarseNow timer, so two surfaces never straddle a tick). */
export const ATTENTION_CLOCK_MS = 60_000;

/** The tasks the groups name, as the store holds them; re-reads only when one of their status, assignee or id changes. */
export function useAttentionTasks(groups: readonly Pick<OpsGroup, "signal_task_id">[]): (id: string) => AttentionTask | undefined {
  const ids = useMemo(() => [...new Set(groups.map((g) => g.signal_task_id).filter((id): id is string => !!id))], [groups]);
  const sig = useInboxStore((s) => ids.map((id) => {
    const t = s.tasks?.[id];
    return t ? `${id}:${t.status ?? ""}:${t.assignee ?? ""}:${t.short_id ?? ""}` : id;
  }).join("|"));
  return useMemo(() => {
    const tasks = useInboxStore.getState().tasks ?? {};
    const out = new Map<string, AttentionTask>();
    for (const id of ids) {
      const t = tasks[id] as { short_id?: string; status?: string; assignee?: string | null } | undefined;
      if (t) out.set(id, { short_id: t.short_id, status: t.status, assignee: t.assignee ?? null });
    }
    return (id: string) => out.get(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig spells the fields read
  }, [sig, ids]);
}

/**
 * A check or metric's flips over the events this device holds, counted once
 * per pass: the one count the Issues lanes and the attention list both read,
 * so a flapper never sits in Escalating on one and Flapping on the other.
 */
export function useIssueFailures(now: number): (g: OpsGroup) => number {
  const events = useOpsEvents();
  return useMemo(() => {
    const memo = new Map<string, number>();
    return (g: OpsGroup) => {
      if (g.kind !== "check" && g.kind !== "metric") return 0;
      if (!memo.has(g._id)) memo.set(g._id, failuresIn(g, events, now));
      return memo.get(g._id)!;
    };
  }, [events, now]);
}

/** The lists the attention model reads, from the store. */
export function useAttentionInput(): AttentionInput {
  const sources = useOpsSources();
  const groups = useOpsGroups();
  const watches = useOpsWatches();
  const replays = useOpsReplays();
  const taskOf = useAttentionTasks(groups);
  const failures = useIssueFailures(useCoarseNow(ATTENTION_CLOCK_MS));
  return useMemo(() => ({ sources, groups, watches, replays, taskOf, failures, replaysCapped: replays.length >= OPS_LIST_LIMIT.replays }), [sources, groups, watches, replays, taskOf, failures]);
}

/** What this person snoozed on the Ops home (opsSnooze.ts). */
export function useOpsSnoozes(): OpsSnoozes | undefined {
  return useInboxStore((s) => s.clientState.ui?.ops_snoozes) as OpsSnoozes | undefined;
}

/** Everything wrong now, worst first, under the one health reading; what is snoozed or muted is left out, so it pages nobody. */
export function useOpsAttention(health: ReadonlyMap<string, SourceHealth>): AttentionItem[] {
  const input = useAttentionInput();
  const now = useCoarseNow(ATTENTION_CLOCK_MS);
  const snoozes = useOpsSnoozes();
  return useMemo(() => splitSnoozed(attentionItems(input, now, (s) => health.get(s._id)), snoozes, now).live, [input, now, health, snoozes]);
}
