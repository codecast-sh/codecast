// An issue's fix as the store holds it: the problem task, the sessions on it
// and the plan they make, and who resolved it, in words. The Fix card, the
// issue page and a metric page read these.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { sessionAwakeAt } from "../../lib/liveness";
import { memberDisplayName } from "../../lib/liveEntities";
import { fixPlan, resolverWords, type FixPlan, type FixSessionFact, type FixStage, type Resolver } from "./issuesModel";
import type { OpsGroup } from "./opsTypes";
import { teamMembersOf } from "../../lib/activeTeam";

export type TaskRow = {
  _id: string;
  short_id?: string;
  title?: string;
  status?: string;
  assignee?: string;
  closed_at?: number;
  updated_at?: number;
  conversation_ids?: string[];
  cause?: { dissolved?: { at: number; note?: string }; merged_into?: string };
  duplicate_of?: string;
  landed?: { sha: string; at: number; url: string; repository: string };
};

/** The group's problem task as the store holds it, read by a signature of the fields the card shows. */
export function useProblemTask(taskId: string | undefined): TaskRow | null {
  const sig = useInboxStore((s) => {
    const t = taskId ? (s.tasks as Record<string, TaskRow>)[taskId] : undefined;
    return t ? JSON.stringify([t.short_id, t.title, t.status, t.assignee, t.closed_at, t.conversation_ids, t.cause?.dissolved, t.cause?.merged_into, t.duplicate_of, t.landed?.sha, t.landed?.at]) : "";
  });
  return useMemo(() => (taskId && sig ? ((useInboxStore.getState().tasks as Record<string, TaskRow>)[taskId] ?? null) : null), [taskId, sig]);
}

/** The sessions behind a fix, each with whether it is awake now, when it last moved (to the minute), and whether this device holds its row. */
export function useFixSessions(ids: string[], now: number): FixSessionFact[] {
  const key = ids.join(",");
  const sig = useInboxStore((s) =>
    ids
      .map((id) => {
        const row = (s.conversations as Record<string, any>)?.[id] ?? (s.sessions as Record<string, any>)?.[id];
        if (!row) return "-";
        const at = row.updated_at ?? row.last_message_at ?? row._creationTime;
        return `${sessionAwakeAt(row, now) ? "1" : "0"}${typeof at === "number" ? Math.floor(at / 60_000) : ""}`;
      })
      .join(","),
  );
  return useMemo(() => {
    const parts = sig.split(",");
    return ids.map((id, i) => {
      const p = parts[i] ?? "-";
      const minute = p.length > 1 ? Number(p.slice(1)) : NaN;
      return { id, awake: p[0] === "1", known: p !== "-", ...(Number.isFinite(minute) ? { at: minute * 60_000 } : {}) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands in for ids
  }, [key, sig]);
}

/** The ids the Fix card weighs: the session started from the issue first, then the task's, at most eight. */
export function fixSessionIds(group: Pick<OpsGroup, "fix_conversation_id">, task: TaskRow | null): string[] {
  return [...new Set([group.fix_conversation_id, ...(task?.conversation_ids ?? [])].filter(Boolean) as string[])].slice(0, 8);
}

export function useIssueFix(group: OpsGroup, stage: FixStage, now: number): { task: TaskRow | null; sessions: FixSessionFact[]; plan: FixPlan } {
  const task = useProblemTask(group.signal_task_id);
  const sessions = useFixSessions(fixSessionIds(group, task), now);
  const plan = useMemo(() => fixPlan(group, stage, sessions), [group, stage, sessions]);
  return { task, sessions, plan };
}

/**
 * Who or what resolved a group, in a few words: "resolved by you", "resolved
 * by Ada", "recovered on its own", "resolved in Sentry", or plain "resolved"
 * when nothing names it. Never "by hand" for a resolve nobody can attribute.
 */
export function useResolverWords(resolver: Resolver, provider?: string): string {
  const name = useInboxStore((s) => {
    if (resolver.via !== "person" || !resolver.by) return null;
    if ((s as any).currentUser?._id === resolver.by) return "you";
    const m = (teamMembersOf(s) as any[]).find((x) => x && String(x._id) === resolver.by);
    return m ? memberDisplayName(m) : null;
  });
  return resolverWords(resolver, name, provider);
}
