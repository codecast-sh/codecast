// What a Dormant row is really doing, read over the store (plan pl-1138): the
// shared sessionActivity, fed the facts the web holds. The rail splits its
// Dormant bucket into Working, Shipping and Sleeping with it, and every other
// surface that names a state (the header chip, the fleet board, /sessions)
// reads the same verdict, so a row says one thing everywhere.
//
// Pure. Its inputs: the triggers into the session (agentTasks and
// foreignTriggers, as dormantWake reads them), where its change is on the way
// to live (lib/ship/sessionShip through sessionShipMap), and the workers it
// spawned (their own rows, childrenRunningOf).
import {
  childrenRunningOf,
  sessionActivity,
  type SessionActivity,
  type ShipInput,
  type ShipStage,
} from "@codecast/shared/contracts/sessionActivity";
import type { DormantTriggerRow } from "@codecast/shared/contracts/dormantWake";
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import type { InboxSession } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { sessionShipMap, type ShipState } from "../hooks/useSessionShipState";
import type { SessionShip } from "./ship/sessionShip";
import type { ActivityKind } from "./sessionStatus";

export type RailActivityState = ShipState & {
  sessions: Record<string, InboxSession>;
  agentTasks?: Record<string, any>;
  foreignTriggers?: Record<string, any>;
};

type Run = { status?: string; current_node_id?: string | null; waiting_on_session?: unknown; takes_change?: boolean };

const LIVE_RUN = new Set(["running", "paused", "pending"]);

/** The ship stage a change flow's station belongs to (the library change flow's node ids: pr, ci, review, merge, deploy, and their fixes). */
export function shipStageOfNode(nodeId: string | null | undefined): ShipStage {
  const top = segmentTopOf(nodeId ?? "");
  if (/deploy/.test(top)) return "deploy";
  if (/^(merge|landed|land|moved|unshipped)$/.test(top)) return "merge";
  if (/review|verdict|decide|^brief$|_fix$|_revise$/.test(top) && !/(^|_)ci(_|$)/.test(top)) return "review";
  return "ci";
}

/** "Deploying · web, cli" → "web, cli". */
const targetOfWords = (words: string): string | null => words.split(" · ")[1] ?? null;

/**
 * Where a session's change is, as sessionActivity reads it: only a change in
 * flight. A run still going names its station (sent back to the session for a
 * fix, it failed there); a landed change going out names its deploy. Live,
 * merged, stopped or a failed deploy nobody is fixing is not shipping.
 */
export function shipInputOf(ship: SessionShip | null | undefined, run: Run | null | undefined, pr: string | null): ShipInput | null {
  if (!ship) return null;
  if (run?.status && LIVE_RUN.has(run.status)) {
    const stage = shipStageOfNode(run.current_node_id);
    return { stage, failed: ship.words === "Fixing", pr, target: stage === "deploy" ? targetOfWords(ship.words) : null };
  }
  if (ship.tone === "working" && /^Deploy/.test(ship.words)) return { stage: "deploy", pr, target: targetOfWords(ship.words) };
  return null;
}

// -- Indexes over the store, each rebuilt only when its collection's ref changes --

let workersMemo: { sessions: unknown; map: Map<string, InboxSession[]> } | null = null;
/** The rows each session spawned (`cast spawn` workers), by spawner. */
function workersBySpawner(sessions: Record<string, InboxSession>): Map<string, InboxSession[]> {
  if (workersMemo?.sessions === sessions) return workersMemo.map;
  const map = new Map<string, InboxSession[]>();
  for (const id in sessions) {
    const s = sessions[id];
    const by = s.spawned_by_conversation_id;
    if (!by) continue;
    const list = map.get(by);
    if (list) list.push(s); else map.set(by, [s]);
  }
  workersMemo = { sessions, map };
  return map;
}

let triggersMemo: { own: unknown; foreign: unknown; byConv: Map<string, DormantTriggerRow[]>; byId: Map<string, DormantTriggerRow> } | null = null;
function triggerIndex(state: RailActivityState) {
  if (triggersMemo?.own === state.agentTasks && triggersMemo.foreign === state.foreignTriggers) return triggersMemo;
  const byConv = new Map<string, DormantTriggerRow[]>();
  const byId = new Map<string, DormantTriggerRow>();
  const add = (conv: unknown, row: DormantTriggerRow) => {
    if (!conv) return;
    const list = byConv.get(String(conv));
    if (list) { if (!list.includes(row)) list.push(row); } else byConv.set(String(conv), [row]);
  };
  for (const coll of [state.agentTasks, state.foreignTriggers]) {
    for (const id in coll ?? {}) {
      const task = coll![id];
      if (byId.has(String(task._id))) continue;
      const row = { task };
      byId.set(String(task._id), row);
      add(task.originating_conversation_id, row);
      add(task.created_by_conversation_id, row);
    }
  }
  triggersMemo = { own: state.agentTasks, foreign: state.foreignTriggers, byConv, byId };
  return triggersMemo;
}

/** The trigger rows into a session, the ones its card would carry (dormantWake sessionTriggerRows), from the store's rosters. */
export function storeTriggerRows(state: RailActivityState, row: Pick<InboxSession, "_id" | "agent_task_id">): DormantTriggerRow[] {
  const { byConv, byId } = triggerIndex(state);
  const own = byConv.get(row._id) ?? [];
  const spawnedBy = row.agent_task_id ? byId.get(row.agent_task_id) : undefined;
  return spawnedBy && !own.includes(spawnedBy) ? [...own, spawnedBy] : own;
}

/** What one Dormant row is doing. `triggers` defaults to the store's rosters; the rail hands its own rows, which carry the countdowns. */
export function rowActivity<T extends DormantTriggerRow = DormantTriggerRow>(state: RailActivityState, row: InboxSession, now: number, triggers?: T[]): SessionActivity<T> {
  const ship = sessionShipMap(state).get(row._id);
  const run = ship?.run ? (state.workflowRuns?.[ship.run] as Run | undefined) : undefined;
  const pr = row.pr_status && row.pr_status.state !== "merged" ? `#${row.pr_status.number}` : null;
  const workers = workersBySpawner(state.sessions).get(row._id) ?? [];
  const running = workers.filter((w) => childrenRunningOf([w], now) > 0);
  const ownRun = row.workflow_run_id ? (state.workflowRuns?.[row.workflow_run_id] as Run | undefined) : undefined;
  return sessionActivity<T>({
    row,
    triggers: triggers ?? (storeTriggerRows(state, row) as T[]),
    childrenRunning: running.length,
    childWork: running.map((w) => w.title ?? "").filter(Boolean),
    ship: shipInputOf(ship, run, pr),
    runShips: !!(ownRun?.takes_change || run?.takes_change),
    now,
  });
}

/** The section a Dormant row draws in. */
export const railActivityKind = (state: RailActivityState, row: InboxSession, now: number): ActivityKind => rowActivity(state, row, now).state;

/** The row facts sessionActivity reads, as one signature over the collection:
 *  a surface subscribes to it (with sessionShipMap and the trigger rosters)
 *  so a split moves when its facts do, never on a heartbeat. */
export const activityFactsSig = makeCollectionSig<InboxSession>((s) => [
  s._id,
  s.agent_status ?? "",
  s.producing_until ?? "",
  (s.open_tasks ?? []).map((t) => `${t.kind}:${(t as { description?: string }).description ?? ""}:${((t as { command?: string }).command ?? "").slice(0, 80)}`).join(","),
  s.workflow_run_id ?? "",
  s.workflow_run_status ?? "",
  s.spawned_by_conversation_id ?? "",
  s.parked_wake_kind ?? "",
  s.armed_trigger_kind ?? "",
  s.pr_status ? `${s.pr_status.number}:${s.pr_status.state}` : "",
  s.waiting_on ? `${s.waiting_on.kind}:${s.waiting_on.ref}:${s.waiting_on.at ?? ""}` : "",
  s.hibernated_at ?? "",
  s.spawned_by_conversation_id ? s.title ?? "" : "",
].join("|"));
