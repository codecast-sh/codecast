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
  type PrRef,
  type SessionActivity,
  type ShipInput,
} from "@codecast/shared/contracts/sessionActivity";
import { canAnswer, runShipsChange, selectSessionRun, shipOfLiveRun, type RunViewerFacts, type ShipRunFacts } from "@codecast/shared/contracts/shipRun";
import type { DormantTriggerRow } from "@codecast/shared/contracts/dormantWake";
import type { InboxSession } from "../store/inboxStore";
import { sessionShipMap, type ShipState } from "../hooks/useSessionShipState";
import { shipHref, type SessionShip } from "./ship/sessionShip";
import { runAskOf, type AskRow } from "./ship/sessionAsk";
import { activeWorkspaceKeyOf } from "./workspaceScope";
import { runHref } from "./decisionLinks";
import { sessionStatusOf, type ActivityKind, type SessionStatus, type SessionStatusInput, type StatusPlacement } from "./sessionStatus";

export type RailActivityState = ShipState & {
  sessions: Record<string, InboxSession>;
  agentTasks?: Record<string, any>;
  foreignTriggers?: Record<string, any>;
  pullRequests?: Record<string, { repository?: string; number?: number; state?: string }>;
};

type Run = ShipRunFacts & {
  _id: string;
  spawner_conversation_id?: string | null;
  workflow_label?: string | null;
  workspace?: string | null;
};

/** "Deploying · web, cli" → "web, cli". */
const targetOfWords = (words: string): string | null => words.split(" · ")[1] ?? null;

/** With no run of the session live, a landed change going out still ships: read off the ship map's deploy reach. */
function reachShipOf(ship: SessionShip | null | undefined, pr: string | null): ShipInput | null {
  return ship && ship.tone === "working" && /^Deploy/.test(ship.words) ? { stage: "deploy", pr, target: targetOfWords(ship.words) } : null;
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
  // The run that speaks for the row (shared selectSessionRun): its live ship
  // run first, never an ended one. Where it stands is the shared rule the
  // server's `cast sessions` reads too (shipOfLiveRun); with none in flight, a
  // landed change going out still reads off the ship map's deploy reach.
  const live = liveRunOf(state, row._id);
  const liveShips = !!live && runShipsChange(live);
  const ownStatus = row.pr_status && row.pr_status.state !== "merged" && row.pr_status.state !== "closed" ? row.pr_status : null;
  const runPr = liveShips && live!.pr ? live!.pr : null;
  const ownPr = ownStatus ? { repository: ownStatus.repository, number: ownStatus.number } : runPr ? { repository: runPr.repository ?? null, number: runPr.number } : null;
  const pr = ownPr ? `#${ownPr.number}` : null;
  const ship = live
    ? (liveShips ? { ...shipOfLiveRun(live, viewerFactsOf(state, live)), ...(pr ? { pr } : {}) } : null)
    : reachShipOf(sessionShipMap(state).get(row._id), pr);
  const workers = workersBySpawner(state.sessions).get(row._id) ?? [];
  // childrenRunningOf is the one judge of a running child (alive, not closed).
  const running = workers.filter((w) => childrenRunningOf([w], now) > 0);
  const ownRun = row.workflow_run_id ? (state.workflowRuns?.[row.workflow_run_id] as Run | undefined) : undefined;
  return sessionActivity<T>({
    row,
    triggers: triggers ?? (storeTriggerRows(state, row) as T[]),
    childrenRunning: running.length,
    childWork: running.map((w) => w.title ?? "").filter(Boolean),
    ship,
    runShips: !!(ownRun && runShipsChange(ownRun)) || liveShips,
    // By the name it is keyed by, as the server reads it (a raw run carries no label).
    runName: live && !liveShips ? live.workflow_name?.trim() || null : null,
    ownPr,
    prEnded: (pr) => prEndedIn(state, pr),
    now,
  });
}

let runsMemo: { runs: unknown; bySpawner: Map<string, Run[]> } | null = null;
/** The runs each session started, by spawner. */
function runsBySpawner(state: RailActivityState): Map<string, Run[]> {
  if (runsMemo && runsMemo.runs === state.workflowRuns) return runsMemo.bySpawner;
  const bySpawner = new Map<string, Run[]>();
  for (const id in state.workflowRuns ?? {}) {
    const r = state.workflowRuns![id] as Run;
    const by = r.spawner_conversation_id ? String(r.spawner_conversation_id) : null;
    if (!by) continue;
    const list = bySpawner.get(by);
    if (list) list.push(r); else bySpawner.set(by, [r]);
  }
  runsMemo = { runs: state.workflowRuns, bySpawner };
  return bySpawner;
}

/** The session's newest live run (pending, running or paused), if the store holds one. */
export function liveRunOf(state: RailActivityState, rowId: string): Run | null {
  return selectSessionRun(runsBySpawner(state).get(rowId) ?? []);
}

/** Who a held run waits on, as the viewer's store knows it: their open approval card, the card its session asks with. */
function viewerFactsOf(state: RailActivityState, run: Run): RunViewerFacts {
  const viewer = state.currentUser?._id ? String(state.currentUser._id) : null;
  const decisions = (state.sessionDecisions ?? {}) as Record<string, AskRow>;
  const ask = runAskOf(run as Parameters<typeof runAskOf>[0], decisions, viewer);
  return {
    gateIsViewers: canAnswer(run.gate_decision_id ? decisions[run.gate_decision_id] ?? null : null, viewer),
    askIsViewers: ask?.open === false ? null : !!ask?.mine,
  };
}

let prsMemo: { prs: unknown; ended: Map<string, boolean> } | null = null;
/** Whether the store knows a pull request has merged or closed (its pullRequests rows). */
function prEndedIn(state: RailActivityState, pr: PrRef): boolean {
  let memo = prsMemo;
  if (!memo || memo.prs !== state.pullRequests) {
    const ended = new Map<string, boolean>();
    for (const id in state.pullRequests ?? {}) {
      const p = state.pullRequests![id];
      if (p?.number == null) continue;
      const done = p.state === "merged" || p.state === "closed";
      ended.set(`${String(p.repository ?? "").toLowerCase()}#${p.number}`, done);
      // By number alone too, for a trigger that names no repository: ended only if every PR with that number is.
      const bare = `#${p.number}`;
      ended.set(bare, (ended.get(bare) ?? true) && done);
    }
    memo = prsMemo = { prs: state.pullRequests, ended };
  }
  const key = pr.repository ? `${pr.repository.toLowerCase()}#${pr.number}` : `#${pr.number}`;
  return memo.ended.get(key) ?? false;
}

/** The ids of rows parked on a run the store lacks a live copy of, or holds only from another workspace than the
 *  team feed covers (sessionFlowRuns.forTeam reads the active team's runs): those need their own run feed. */
export function rowsNeedingRunFeed(state: RailActivityState): string {
  const workspace = activeWorkspaceKeyOf(state);
  if (feedMemo && feedMemo.sessions === state.sessions && feedMemo.runs === state.workflowRuns && feedMemo.workspace === workspace) return feedMemo.ids;
  const ids: string[] = [];
  for (const id in state.sessions) {
    const s = state.sessions[id];
    if (s.parked_wake_kind !== "run" || s.inbox_killed_at || s.inbox_dismissed_at) {
      fedRows.delete(id);
      continue;
    }
    const live = liveRunOf(state, id);
    // A row once fed stays fed while it is parked on a run: the run its feed
    // brought in must keep moving, not freeze at the step that stopped the feed.
    if (fedRows.has(id) || !live || (live.workspace && live.workspace !== workspace)) {
      fedRows.add(id);
      ids.push(id);
    }
  }
  feedMemo = { sessions: state.sessions, runs: state.workflowRuns, workspace, ids: ids.sort().slice(0, RUN_FEED_CAP).join(",") };
  return feedMemo.ids;
}
let feedMemo: { sessions: unknown; runs: unknown; workspace: string | null; ids: string } | null = null;
const fedRows = new Set<string>();
/** A handful at most: a session parked on a run outside the team feed is rare. */
export const RUN_FEED_CAP = 12;

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
  const on = a.flavor === "waiting" && a.on ? `${a.on.kind}:${a.on.ref}:${a.on.label ?? ""}:${a.since ?? ""}` : "";
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

/** dormantActivityOf with the store and clock bound, for nested rows: a caller that holds the store hands it to subagentRowsOf. */
export type SubagentActivityOf = (session: InboxSession, bucket: string) => ActivityKind | null;

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

/** What rows moved out of Dormant weigh in a section's header number: with
 *  subagents as Full rows (`keep`, the "Which ones" filter's own rule), each
 *  takes along the rows nested under it that Dormant's count holds. */
export function movedWeight(rows: readonly InboxSession[], keep: ((sub: InboxSession) => boolean) | null, subsByParent: ReadonlyMap<string, readonly InboxSession[]>, nestedSectionOf: ReadonlyMap<string, string>): number {
  if (!keep) return rows.length;
  return rows.reduce((n, r) => n + 1 + (subsByParent.get(r._id) ?? []).filter((sub) => nestedSectionOf.get(sub._id) === "dormant" && keep(sub)).length, 0);
}
