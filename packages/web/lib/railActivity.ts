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
import { sessionShipMap, type ShipState } from "../hooks/useSessionShipState";
import { shipHref, type SessionShip } from "./ship/sessionShip";
import { runHref } from "./decisionLinks";
import { sessionStatusOf, type ActivityKind, type SessionStatus, type SessionStatusInput, type StatusPlacement } from "./sessionStatus";

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

/** Who a held step waits on: the viewer ("Your call", "Waiting on you",
 *  "Waiting for you to deploy") or someone else ("Waiting for green main",
 *  "Waiting for Ashot to deploy"). Null while the step is plain progress. */
function holderOf(ship: SessionShip): "you" | "other" | null {
  if (ship.tone === "you" || (ship.tone === "wait" && /\byou\b/i.test(ship.words))) return "you";
  return ship.tone === "wait" ? "other" : null;
}

/**
 * Where a session's change is, as sessionActivity reads it: only a change in
 * flight. A run still going names its station (sent back to the session for a
 * fix, it failed there), and a step held for a person says the hold in its
 * own words; a landed change going out names its deploy. Live, merged,
 * stopped or a failed deploy nobody is fixing is not shipping.
 */
export function shipInputOf(ship: SessionShip | null | undefined, run: Run | null | undefined, pr: string | null): ShipInput | null {
  if (!ship) return null;
  if (run?.status && LIVE_RUN.has(run.status)) {
    const stage = shipStageOfNode(run.current_node_id);
    const holder = holderOf(ship);
    return { stage, failed: ship.words === "Fixing", pr, target: stage === "deploy" ? targetOfWords(ship.words) : null, ...(holder ? { holder, words: ship.words } : {}) };
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

type TriggerIndex = { own: unknown; foreign: unknown; byConv: Map<string, DormantTriggerRow[]>; byId: Map<string, DormantTriggerRow> };
let triggersMemo: TriggerIndex | null = null;
function triggerIndex(state: RailActivityState): TriggerIndex {
  if (triggersMemo && triggersMemo.own === state.agentTasks && triggersMemo.foreign === state.foreignTriggers) return triggersMemo;
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
  // childrenRunningOf is the one judge of a running child (alive, not closed).
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

/** Everything a row's line draws from its activity, as one string: what a
 *  surface subscribes to, so it wakes when the words, stage or wake move and
 *  never on a run, deploy or heartbeat that changed none of them. */
export function activitySig(a: SessionActivity): string {
  if (a.state === "working") return `w|${a.words}`;
  if (a.state === "shipping") return `s|${a.stage}|${a.failed ? 1 : 0}|${a.holder ?? ""}|${a.words}`;
  const wake = a.wake;
  const wakeKey = !wake ? ""
    : wake.kind === "trigger" ? `trigger:${wake.row.task.run_at ?? ""}:${wake.row.task.status}:${wake.others}`
    : wake.kind === "claim" ? `claim:${wake.back}:${wake.what ?? ""}`
    : wake.kind === "snoozed" ? `snoozed:${wake.at}`
    : wake.kind === "unconfirmed" ? `unconfirmed:${wake.since}`
    : wake.kind === "background" ? `background:${wake.count}:${wake.what}`
    : wake.kind;
  const on = a.flavor === "waiting" && a.on ? `${a.on.kind}:${a.on.ref}:${a.since ?? ""}` : "";
  return `z|${a.flavor}|${a.hibernated ? 1 : 0}|${on}|${wakeKey}`;
}

/** The split of a set of Dormant rows, as one signature (id and activitySig per row). */
export function dormantSplitSig<T extends DormantTriggerRow>(state: RailActivityState, rows: readonly InboxSession[], now: number, triggersOf?: (row: InboxSession) => T[]): string {
  let out = "";
  for (const row of rows) out += `${row._id}=${activitySig(rowActivity(state, row, now, triggersOf?.(row)))};`;
  return out;
}

/**
 * The split a row's status word reads where no section decides it (a board
 * tile, a /sessions row, a flat or nested card, a window row, an activity
 * item): its placement's bucket, and for a Dormant one what it is really
 * doing. Every such surface asks this, so none can drift from the rail.
 */
export function dormantActivityOf(state: RailActivityState, row: InboxSession, bucket: string | null | undefined, now: number): ActivityKind | null {
  return bucket === "dormant" ? rowActivity(state, row, now).state : null;
}

/** A row's status where no section decides: sessionStatusOf over its placement, with a Dormant one split. */
export function placedStatusOf(state: RailActivityState, input: Omit<SessionStatusInput, "activity" | "section"> & { placement: StatusPlacement | null }): SessionStatus {
  return sessionStatusOf({ ...input, activity: dormantActivityOf(state, input.row as InboxSession, input.placement?.bucket, input.now) });
}

/** Where a Shipping row held for the viewer goes to act: the run that asks, or the deploy it waits on. */
export function shipActionHref(state: RailActivityState, rowId: string): string | null {
  const ship = sessionShipMap(state).get(rowId);
  if (!ship) return null;
  return shipHref(ship) ?? (ship.run ? runHref(ship.run) : null);
}
