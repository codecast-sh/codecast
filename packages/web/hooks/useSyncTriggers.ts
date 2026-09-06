// Triggers (agent_tasks) — store-fed. Mount useSyncTriggers once app-wide
// (DashboardSyncEffects); every surface reads store.agentTasks through the
// readers below.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { ARMED_STATUSES, foreignTriggerConvIds, mergeTriggerRosters, type TaskRow } from "../components/triggerTasks";
import { makeCollectionSig } from "../store/wakeSig";
import { useSyncCollection, keyRowsBy } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const api = _api as any;

/** Feeder: the viewer's complete trigger set (snapshot sync — see registry). */
export function useSyncTriggers(enabled = true) {
  return useSyncCollection("agentTasks", api.agentTasks.webList, enabled ? {} : "skip");
}

// The fields trigger surfaces render; a change to anything else on the row
// (lease stamps, retry counters) doesn't wake them.
export const triggerSig = (t: any) =>
  `${t.status}|${t.run_at ?? 0}|${t.last_run_at ?? 0}|${t.run_count ?? 0}|${t.display_title ?? t.title}|${t.display_summary ?? ""}|${t.last_run_needs_attention ? 1 : 0}|${t.last_run_failed ? 1 : 0}|${t.last_run_summary ?? ""}|${t.last_run_conversation_id ?? ""}|${t.schedule_type}|${t.interval_ms ?? 0}|${t.mode}|${t.prompt}|${t.precheck ?? ""}|${t.last_precheck_skip_at ?? 0}|${t.last_precheck_skip_reason ?? ""}|${t.last_run_source ?? ""}`;
const newestFirst = (a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0);

// Which conversations the viewer sees carry an armed trigger their own roster
// cannot explain — the ONLY session field this reads, so heartbeat churn on the
// rest of the row never re-runs the candidate scan.
const armedStampSig = makeCollectionSig<any>((s) => `${s?._id ?? ""}:${s?.armed_trigger_kind ?? ""}`);

// The query answers with EVERY trigger anchored to those conversations; the
// roster wants only the armed ones. Dropping the rest here keeps this
// collection to the handful of rows the roster is missing, instead of
// accumulating one conversation's whole trigger history.
const keepArmed = (rows: any[]) => (rows ?? []).filter((t) => ARMED_STATUSES.has(t.status));

/** Feeder: the anchored foreign triggers (see components/triggerTasks.ts,
 *  foreignTriggerConvIds). Skips entirely when the roster explains every
 *  armed stamp — the common case, and then this costs no subscription. */
export function useSyncForeignTriggers(own: TaskRow[], enabled = true) {
  const stampSig = useInboxStore(useCallback((s: any) => armedStampSig(s.sessions), []));
  // A comma-joined key, not the array: the array IS the subscription args, so
  // a fresh-but-equal one would resubscribe on every render.
  const key = useMemo(
    () =>
      foreignTriggerConvIds(useInboxStore.getState().sessions as any, own)
        .filter(isConvexId)
        .join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stampSig IS the armed-stamp digest of s.sessions; depending on the raw collection would re-run this on every heartbeat
    [stampSig, own],
  );
  const args = useMemo(
    () => (enabled && key ? { conversation_ids: key.split(",") } : ("skip" as const)),
    [enabled, key],
  );
  return useSyncCollection("foreignTriggers", api.agentTasks.webListForConversations, args, {
    select: keepArmed,
  });
}

/**
 * Reader: every trigger, newest first, from the store. `ready` is false only
 * until the first live answer; a populated cache is the ordinary first
 * paint, not a loading state.
 *
 * "Every" means own AND anchored foreign: a trigger armed by a remote daemon's
 * bot login on a conversation the viewer can see is the viewer's trigger to
 * read, even though webList (indexed by user_id) can never carry it.
 */
export function useTriggers(): { tasks: any[]; ready: boolean } {
  const { ready } = useSyncTriggers();
  const own = useCollectionRows<any>("agentTasks", { sig: triggerSig, sort: newestFirst });
  // Gated on the own roster having landed: before it does, every armed stamp
  // looks unexplained, and the feeder would ask for the whole set and then
  // immediately narrow.
  useSyncForeignTriggers(own, ready || own.length > 0);
  const foreign = useCollectionRows<any>("foreignTriggers", { sig: triggerSig, sort: newestFirst });
  const tasks = useMemo(() => mergeTriggerRosters(own, foreign, newestFirst), [own, foreign]);
  return { tasks, ready };
}

/**
 * A trigger's run history. The server's `_id` is the run's conversation id
 * and repeats across inject-mode runs, so rows are keyed by run_key and
 * stamped with their task_id so the reader can select by task.
 */
export function useSyncTriggerRuns(taskId: string | null | undefined) {
  const select = useCallback(
    (rows: any[]) => keyRowsBy(rows, "run_key").map((r) => ({ ...r, task_id: taskId })),
    [taskId],
  );
  return useSyncCollection(
    "agentTaskRuns",
    api.agentTasks.webListRuns,
    taskId ? { task_id: taskId } : "skip",
    { select },
  );
}

const runSig = (r: any) => `${r.status}|${r.title}|${r.idle_summary ?? ""}|${r.kind}`;

/** Reader: one trigger's runs, newest first, from the store. Pass null to
 *  skip (a collapsed row costs no query). Returns undefined only while the
 *  cache is empty AND the first answer is in flight. */
export function useTriggerRuns(taskId: string | null | undefined): any[] | undefined {
  const { ready } = useSyncTriggerRuns(taskId);
  const where = useMemo(() => (taskId ? (r: any) => r.task_id === taskId : () => false), [taskId]);
  const runs = useCollectionRows<any>("agentTaskRuns", { where, sig: runSig, sort: newestFirst });
  if (!taskId) return undefined;
  if (runs.length > 0) return runs;
  return ready ? runs : undefined;
}

/**
 * One-shot fetch of a trigger's runs for a click that needs the newest run
 * NOW (deep-linking to its trigger message). Serves the store's cached rows
 * when it has any; otherwise queries and lands the page in the store so the
 * next click (and the run rail) read it for free.
 */
export async function fetchTriggerRuns(convex: { query: (q: any, args: any) => Promise<any> }, taskId: string): Promise<any[]> {
  const cached = (Object.values(useInboxStore.getState().agentTaskRuns) as any[])
    .filter((r) => r?.task_id === taskId)
    .sort(newestFirst);
  if (cached.length > 0) return cached;
  const rows = await convex.query(api.agentTasks.webListRuns, { task_id: taskId });
  const keyed = keyRowsBy(rows as any[], "run_key").map((r) => ({ ...r, task_id: taskId }));
  useInboxStore.getState().syncTable("agentTaskRuns", keyed);
  return keyed.sort(newestFirst);
}
