// Deploys as objects (docs/architecture/deploys.md). One row per version that
// went live, or was asked to, on one target. Two writers:
//
//  - The line's deploy stage (DP2): `request` takes the project's shipped
//    fixes that no live deploy has carried yet and asks for one deploy that
//    sends them together. The machine that publishes the line profile runs the
//    team's deploy path (`cast line deploy run dp-N`) and reports through
//    `report`.
//  - A deploy marker (DP1): `recordDeployMarker`, called by
//    changesDeploy.markDeploy (`cast ship mark`) and by ingest's deploy items.
//    A marker finishes the line's open deploy on the same target, enriches the
//    deploy it already recorded, or records a deploy nobody asked for, carrying
//    the fixes the history's rule says it carried.
//
// What happened after (DP5) is derived at read: the carried problems'
// findings after the deploy went live, and the error groups that started or
// came back in its window.

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUserOrToken } from "./lib/auth";
import { canAccessProject, resolveWorkspaceKey, workspaceGrantsAccess } from "./lib/access";
import { nextShortId } from "./counters";
import { enqueueConfigCommand } from "./users";
import { normalizeRepository } from "./lib/gitRefs";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { deployIsLive } from "@codecast/shared/contracts/causeHistory";
import { normalizeRoleHandle } from "@codecast/shared/contracts/lineDeploy";
import { deployAllowance, deployGrantOf, type DeployAllowance } from "./lib/deployAllowance";
import { countersFor } from "./lib/orgCaps";
import { tellRole } from "./pendingMessages";
import { liveRoleByHandle } from "./lib/orgAccess";
import { scheduleTriggerMatch } from "./lib/triggerMatch";
import { emitNotification } from "./notificationRouter";
import { fillDeployRange } from "./deployTargets";
import { afterFor, shapeView } from "./deploysView";
import { devPushedOver, targetDeploys, targetDevPushes } from "./deployTargetsState";
import { DEPLOY_FAILED_EVENT, DEPLOY_LIVE_EVENT } from "@codecast/shared/contracts";
import {
  carriesForMarker,
  deployRowOf,
  isLiveDeploy,
  runIdOf,
  sameSha,
  workspaceDeploys,
  workspaceMerges,
} from "./deployCarries";
import {
  actionsRunKey,
  DAY,
  DEPLOY_SHORT_ID_PREFIX,
  DEPLOY_SHORT_ID_RE,
  liveDeployOf,
  liveDeploys,
  normalizeDeployTarget,
  waitingMerges,
  type DeployMerge,
  type DeployStatus,
} from "@codecast/shared/contracts/deploys";

/** A line deploy older than this, still waiting for its marker, no longer takes one. */
const OPEN_DEPLOY_MAX_AGE_MS = DAY;
const NOTE_MAX = 2000;
/** A role asks for a deploy only once the newest waiting fix has sat this long, so a burst of merges goes out as one deploy. */
export const DEPLOY_SETTLE_MS = 30 * 60 * 1000;
const COMMITS_MAX = 200;
/** A deploy keeps at most this many names in `adds` and in `drops`, each cut to NAME_MAX characters. */
const NAMES_MAX = 500;
const NAME_MAX = 200;
/** How far back through a target's deploys, and through its dev pushes, a name's adder is looked for. */
const ADDERS_SCAN = 200;
/** A marker reads this many of the workspace's deploys; the live deploy is looked for among this many of the target's. */
const MARKER_SCAN = 100;
/** A person told a deploy dropped their work is not told again for this long. */
const DROPPED_WORK_QUIET_MS = 6 * 60 * 60 * 1000;
/** How many of a person's newest notifications in the quiet window are read for an earlier notice. */
const DROPPED_WORK_QUIET_SCAN = 100;

/** The classes of name a cut keeps first: a dropped table or index is the loss that matters most. */
const NAME_CLASSES = ["table:", "index:", "http:", "fn:"];
const nameClass = (name: string) => {
  const i = NAME_CLASSES.findIndex((p) => name.startsWith(p));
  return i < 0 ? NAME_CLASSES.length : i;
};

/**
 * Names as a deploy keeps them: each cut to NAME_MAX, no repeats, in the lists' order. Past NAMES_MAX the tables
 * are kept first, then indexes, routes and functions, each class sorted, and the rest cut.
 */
export function capNames(...lists: Array<ReadonlyArray<string> | undefined>): string[] {
  const all = new Set<string>();
  for (const list of lists) for (const name of list ?? []) all.add(name.slice(0, NAME_MAX));
  if (all.size <= NAMES_MAX) return [...all];
  return [...all].sort((a, b) => nameClass(a) - nameClass(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, NAMES_MAX);
}

/** The target's current live deploy among `recent`, of the repository when both name one: the one that went live last (liveDeployOf). */
export function liveOf(recent: ReadonlyArray<Doc<"deploys">>, target: string, repository: string | undefined): Doc<"deploys"> | undefined {
  return liveDeployOf(recent, { target, repository });
}

/** The target's latest live deploy, among its newest MARKER_SCAN deploys. */
export async function latestLiveDeploy(ctx: any, workspace: string, target: string, repository?: string): Promise<Doc<"deploys"> | null> {
  const t = normalizeDeployTarget(target);
  if (!t) return null;
  return liveOf(await targetDeploys(ctx, workspace, t, MARKER_SCAN), t, repository ? normalizeRepository(repository) : undefined) ?? null;
}

type StartedBy = Doc<"deploys">["started_by"];

/** Whether two pushes were made by one pusher: the same account, else (neither has one) the same name. */
function samePusher(a: StartedBy, b: StartedBy): boolean {
  if (a?.user_id || b?.user_id) return !!a?.user_id && !!b?.user_id && String(a.user_id) === String(b.user_id);
  return (a?.name ?? null) === (b?.name ?? null);
}

/** A push that can put a name on a target or take it off: a deploy, or a dev watcher's push. `at` is when it was last active. */
export type Push =
  | { kind: "deploy"; row: Doc<"deploys">; at: number }
  | { kind: "dev_push"; row: Doc<"dev_pushes">; at: number };

/**
 * A target's recent pushes of one repository, from both tables: its newest `take` deploys and its `take` dev pushes
 * saved last.
 */
export async function targetPushes(ctx: any, workspace: string, target: string, repository: string | null, take = ADDERS_SCAN): Promise<Push[]> {
  const [deploys, devPushes] = await Promise.all([targetDeploys(ctx, workspace, target, take), targetDevPushes(ctx, workspace, target, take)]);
  const here = (r: { repository?: string }) => (r.repository ?? null) === repository;
  return [
    ...deploys.filter(here).map((row): Push => ({ kind: "deploy", row, at: row.live_at ?? row.created_at })),
    ...devPushes.filter(here).map((row): Push => ({ kind: "dev_push", row, at: row.live_at })),
  ];
}

/**
 * Who put `name` on a target: of `pushes` (one target and repository), the one active last whose adds hold it.
 * `committed_in` is the earliest clean live deploy active after it whose diff ran (it recorded `drops`, even empty), kept
 * the name, and read prod at or after the adder's last push: that tree held the name, so by then it was in a commit. A
 * diff read before the adder's last push says nothing of it. A later push of either kind that dropped the name ends the
 * search. Pushes are read by when they were last active, so a dev push's add counts from its latest save, and a drop
 * made before the name was put back never ends the search.
 */
export function adderOf(pushes: ReadonlyArray<Push>, name: string): { adder: Push; committed_in: Doc<"deploys"> | null } | null {
  const byActivity = [...pushes].sort((a, b) => b.at - a.at || b.row._creationTime - a.row._creationTime);
  const i = byActivity.findIndex((p) => p.row.adds?.includes(name));
  if (i < 0) return null;
  const adder = byActivity[i];
  for (let j = i - 1; j >= 0; j--) {
    const p = byActivity[j];
    if (p.kind === "deploy" && p.row.status !== "live") continue;
    if (p.row.drops?.includes(name)) break;
    if (p.kind === "deploy" && !p.row.dirty && Array.isArray(p.row.drops) && p.row.changes_read_at != null && p.row.changes_read_at >= adder.at) {
      return { adder, committed_in: p.row };
    }
  }
  return { adder, committed_in: null };
}

/**
 * A dev push's adds and drops after one more save: the net change of all its saves against what prod ran before the
 * row began. A name the save adds that the row had dropped is back as it was (off drops), else the row added it; a
 * name the save drops that the row had added never existed before the row (off adds), else the row dropped it.
 */
function netChange(row: Pick<Doc<"dev_pushes">, "adds" | "drops">, adds: ReadonlyArray<string>, drops: ReadonlyArray<string>): { adds: string[]; drops: string[] } {
  const added = new Set(row.adds), dropped = new Set(row.drops);
  for (const n of adds) if (!dropped.delete(n)) added.add(n);
  for (const n of drops) if (!added.delete(n)) dropped.add(n);
  return { adds: capNames([...added]), drops: capNames([...dropped]) };
}

/** The names of `next` that `before` did not hold: what a write newly recorded. */
const newNames = (next: ReadonlyArray<string>, before: ReadonlyArray<string> | undefined) => {
  const had = new Set(before ?? []);
  return next.filter((n) => !had.has(n));
};

// ── the dev watcher's pushes ──────────────────────────────────────────────────

export type DevPushMark = {
  workspace: string;
  team_id?: Id<"teams">;
  target: string;
  repository?: string;
  sha: string;
  machine?: string;
  started_by?: StartedBy;
  dirty?: number;
  /** Names the save put on the target and took off it; both sent, possibly empty, exactly when its diff ran. */
  adds?: string[];
  drops?: string[];
  at: number;
};

/**
 * Record a dev watcher's push: never a deploy (no deploys row, no event, no
 * trigger), a dev push. A save lands on its pusher's row of the same
 * repository, machine and sha that began after the target's live deploy went
 * live, and starts a row of its own otherwise: between deploys, one row per
 * pusher, machine and sha however many saves, and two people whose machines
 * share a hostname keep a row each. The row holds the net change of its saves
 * (netChange). What the save newly drops is told to whoever's uncommitted push
 * put it there (noticeDroppedWork). Returns the row, or null for a target no
 * user reaches.
 */
export async function recordDevPush(ctx: any, m: DevPushMark): Promise<Id<"dev_pushes"> | null> {
  const target = normalizeDeployTarget(m.target);
  if (!target) return null;
  const now = Date.now();
  const repository = m.repository ? normalizeRepository(m.repository) : undefined;
  const machine = m.machine?.trim().slice(0, NAME_MAX) || undefined;
  const sha = m.sha.trim().toLowerCase();
  const diffRan = Array.isArray(m.adds) || Array.isArray(m.drops);
  const adds = capNames(m.adds);
  const drops = capNames(m.drops);
  const live = await latestLiveDeploy(ctx, m.workspace, target, repository);
  const since = live ? live.live_at ?? live.created_at : null;
  const mine: Doc<"dev_pushes">[] = await ctx.db
    .query("dev_pushes")
    .withIndex("by_workspace_target_machine_sha", (q: any) => {
      const range = q.eq("workspace", m.workspace).eq("target", target).eq("machine", machine).eq("sha", sha);
      return since == null ? range : range.gt("created_at", since);
    })
    .order("desc")
    .take(20);
  const own = mine.find((p) => (p.repository ?? null) === (repository ?? null) && samePusher(p.started_by, m.started_by));
  const dropper = { workspace: m.workspace, target, repository, machine, deploy: null, on: live?.short_id ?? null };

  if (own) {
    // Another dev push saved since this row's last save put the target's names back as its tree has them: everything
    // this save drops is dropped again.
    const later = await targetDevPushes(ctx, m.workspace, target, 5, own.live_at);
    const wasLast = !later.some((p) => String(p._id) !== String(own._id) && (!p.repository || !repository || p.repository === repository));
    const next = diffRan ? netChange(own, adds, drops) : { adds: own.adds, drops: own.drops };
    await ctx.db.patch(own._id, { ...next, dirty: m.dirty ?? 0, live_at: m.at, updated_at: now });
    const dropped = !diffRan ? [] : wasLast ? newNames(next.drops, own.drops) : drops.filter((n) => next.drops.includes(n));
    await scheduleDroppedWork(ctx, { ...dropper, exclude: String(own._id) }, dropped, m.started_by);
    return own._id;
  }
  const id: Id<"dev_pushes"> = await ctx.db.insert("dev_pushes", {
    workspace: m.workspace,
    ...(m.team_id ? { team_id: m.team_id } : {}),
    ...(repository ? { repository } : {}),
    target,
    sha,
    ...(machine ? { machine } : {}),
    ...(m.started_by ? { started_by: m.started_by } : {}),
    dirty: m.dirty ?? 0,
    adds,
    drops,
    created_at: m.at,
    live_at: m.at,
    updated_at: now,
  });
  await scheduleDroppedWork(ctx, { ...dropper, exclude: String(id) }, drops, m.started_by);
  return id;
}

const OPEN: ReadonlySet<DeployStatus> = new Set(["requested", "running"]);

/** A deploy a report or marker may still finish: an open one, or one closed only because a newer deploy went live. */
const finishable = (d: Pick<Doc<"deploys">, "status" | "superseded_by">) => OPEN.has(d.status) || (d.status === "cancelled" && !!d.superseded_by);

/** The words a superseded deploy is closed with. */
export const supersededNote = (by: string) => `superseded by ${by}, never reported live`;

/**
 * The open deploys of a live deploy's target asked for before it: a newer deploy went live, so they never will as
 * asked. Closed as cancelled, naming the deploy that superseded them (unless `dry`); returned either way.
 */
export async function closeSuperseded(ctx: any, live: Doc<"deploys">, opts: { dry?: boolean; now?: number } = {}): Promise<Doc<"deploys">[]> {
  if (live.status !== "live") return [];
  const before: Doc<"deploys">[] = await ctx.db
    .query("deploys")
    .withIndex("by_workspace_target_created", (q: any) => q.eq("workspace", live.workspace).eq("target", live.target).lt("created_at", live.created_at))
    .order("desc")
    .take(200);
  const stale = before.filter((d) => OPEN.has(d.status) && (!d.repository || !live.repository || d.repository === live.repository));
  if (!opts.dry) {
    const now = opts.now ?? Date.now();
    for (const d of stale) {
      await ctx.db.patch(d._id, { status: "cancelled", superseded_by: live.short_id, finished_at: now, updated_at: now, note: [supersededNote(live.short_id), d.note].filter(Boolean).join("\n") });
    }
  }
  return stale;
}

/** Whether a deploy is in a project's scope: its own project, else its repository's projects, else (a workspace-wide source) every project. */
function inScope(d: Pick<Doc<"deploys">, "project_id" | "repository">, projectId: string | null, repositories: ReadonlySet<string> | null): boolean {
  if (d.project_id) return !projectId || String(d.project_id) === projectId;
  if (d.repository && repositories) return repositories.has(d.repository);
  return true;
}

/** The project and every project in its workspace whose line profile publishes from the same checkout. */
async function projectsSharingRoot(ctx: any, project: Doc<"projects">, workspace: string): Promise<Set<string>> {
  const out = new Set([String(project._id)]);
  const root = (project as any).line_profile?.root;
  if (!root) return out;
  const rows = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(500);
  for (const p of rows) if (p.line_profile?.root === root) out.add(String(p._id));
  return out;
}

/** The project's waiting set: its merges no live deploy carried and no open line deploy is sending. */
async function waitingFor(ctx: any, project: Doc<"projects">, workspace: string, now: number) {
  const projectId = String(project._id);
  const [merges, deploys] = await Promise.all([workspaceMerges(ctx, workspace, now), workspaceDeploys(ctx, workspace)]);
  const mine = deploys.filter((d) => inScope(d, projectId, null));
  const live = mine.filter(isLiveDeploy).map(deployRowOf);
  // What an open deploy is sending, by run and by problem (a landed fix has no run).
  const sending = new Set(mine.filter((d) => OPEN.has(d.status)).flatMap((d) => d.carries.flatMap((c) => [String(c.task_id), ...(c.run_id ? [String(c.run_id)] : [])])));
  // One deploy ships one checkout: every project whose line publishes from the same root waits on it (Union's eight lines, one repo).
  const shipped = await projectsSharingRoot(ctx, project, workspace);
  const waiting = waitingMerges(merges.filter((m) => !!m.project_id && shipped.has(m.project_id)), live).filter((m) => !sending.has(m.run_id) && !sending.has(m.task_id));
  const open = mine.find((d) => OPEN.has(d.status)) ?? null;
  return { waiting, open };
}

// ── the marker path (DP1) ─────────────────────────────────────────────────────

export type DeployMarker = {
  workspace: string;
  team_id?: Id<"teams">;
  project_id?: Id<"projects">;
  /** The surface or environment the marker names. */
  target: string;
  sha?: string;
  version?: string;
  repository?: string;
  source: string;
  source_id?: Id<"event_sources">;
  event_id?: Id<"external_events">;
  url?: string;
  previous_sha?: string;
  commits?: Array<{ sha: string; subject: string; author?: string }>;
  started_by?: Doc<"deploys">["started_by"];
  /** What the marker says happened: live (the default), still running, failed, or cancelled before it went out. */
  status?: "live" | "running" | "failed" | "cancelled";
  /**
   * The Actions run the marker reports (its id, `/attempts/N` for a rerun): such a marker speaks only for that run's
   * deploy, and a deploy already tied to another run is never its match.
   */
  workflow_run?: string;
  /** The run's name named `sha`: it corrects the run's head an earlier delivery recorded before GitHub filled the name in. */
  sha_named?: true;
  /** When what it reports began (a run's start), when that is earlier than `at`: a new deploy's created_at. */
  started_at?: number;
  note?: string;
  /** Uncommitted files under the target's sources that went out with the sha. */
  dirty?: number;
  ship_pass_id?: Id<"ship_passes">;
  /** The deploy the marker finishes (dp-N), when the deploy path knows it: its sha is what actually went out. */
  deploy?: string;
  /** The hostname of the machine that pushed. */
  machine?: string;
  /** Which push path sent it. The dev watcher's pushes are dev pushes (recordDevPush), never markers. */
  pushed_via?: "deploy.sh";
  /** Names the push put on the target and took off it (`fn:`, `http:`, `index:`, `table:`). */
  adds?: string[];
  drops?: string[];
  /** When the push's diff read prod (adderOf), by the server's clock. */
  changes_read_at?: number;
  /**
   * The marker reports a push its deploy path just made (`cast ship mark`, a ship pass's deploy step), not a report of
   * a deploy already made (a live reader, a GitHub status, a backfill, a past deploy).
   */
  push?: boolean;
  at: number;
};

/**
 * Record a deploy marker as a deploy object, once. Returns the deploy's short
 * id, or null when the marker names a place no user reaches (a laptop's boot).
 *
 *  1. The deploy this marker already recorded (same target and sha or
 *     version): enriched with what the marker adds.
 *  2. An open line deploy on the same target, asked for within a day: the
 *     marker finishes it (live, with the sha).
 *  3. Otherwise a deploy of its own, started outside the line, carrying the
 *     fixes the history's rule says it carried.
 *
 * Unless it names its deploy or run, a marker that is dirty or added or
 * dropped names is a deploy of its own. Any other marker that reports a deploy
 * already made (a live reader, a GitHub status, a backfill) lands on any live
 * deploy of its sha, clean or dirty; a fresh push (`push`) lands only on the
 * clean deploy the target runs now, with no dev push on top of it (a retry).
 *
 * Names the write newly drops are told to whoever's uncommitted push put them
 * there (noticeDroppedWork, once this write commits).
 */
export async function recordDeployMarker(ctx: any, m: DeployMarker): Promise<string | null> {
  const target = normalizeDeployTarget(m.target);
  if (!target || !deployIsLive({ environment: target })) return null;
  const now = Date.now();
  const status = m.status ?? "live";
  const repository = m.repository ? normalizeRepository(m.repository) : undefined;
  const recent = await workspaceDeploys(ctx, m.workspace, MARKER_SCAN);
  // The push's diff ran exactly when it reports adds and drops (each possibly empty); an older cast, or a prod the diff
  // could not read, reports neither, and its row records neither.
  const diffRan = Array.isArray(m.adds) || Array.isArray(m.drops);
  const adds = diffRan ? capNames(m.adds) : undefined;
  const drops = diffRan ? capNames(m.drops) : undefined;
  const machine = m.machine?.slice(0, NAME_MAX);

  const named = m.deploy ? recent.find((d) => d.short_id === m.deploy!.toLowerCase()) ?? (await deployByRef(ctx, m.deploy)) : null;
  const ownNamed = named && named.workspace === m.workspace && named.target === target ? named : null;
  // A workflow run's marker never lands on a deploy another run carries: two runs of one sha are two deploys.
  const ownRun = m.workflow_run ? (await deploysOfRun(ctx, m.workflow_run)).find((d) => d.workspace === m.workspace && d.target === target) : undefined;
  const runFree = (d: Doc<"deploys">) => !m.workflow_run || !d.workflow_run;
  // A run that went live may be the target's live deploy another path already recorded; a run still going, failed,
  // or shipping the sha of a superseded deploy (a rollback) is a deploy of its own.
  const currentLive = m.workflow_run ? liveOf(recent, target, repository) : undefined;
  // A push (`cast ship mark`, a ship pass's deploy step) speaks for the target as it runs now: it lands only on the
  // target's current live deploy (or the deploy that already holds its event, a report of it again). An older live
  // deploy of the sha was replaced since, so the sha going live again is a deploy of its own. Any other marker (a
  // status re-sent for an old commit, a past deploy, a backfill) reports a deploy already recorded: it lands on any
  // live deploy of its sha.
  const push = !!m.push;
  const runningNow = liveOf(recent, target, repository);
  // A push over someone's dev push put the committed tree back: what runs changed, so it is a deploy of its own.
  const overDevPush = push && !!runningNow && (await devPushedOver(ctx, runningNow));
  // A push that changed what runs (uncommitted files, names it added or dropped) is a deploy of its own: two people's
  // dirty trees of one HEAD are two deploys, and folding one into the other hides what it dropped. Only a clean push
  // that changed nothing is the clean live deploy of its sha again (a retry). It may still finish an open deploy or
  // the one it names.
  const changes = !!m.dirty || !!adds?.length || !!drops?.length;
  const liveMatch = (d: Doc<"deploys">) => d.status === "live" && (m.workflow_run
    // A dirty push of a sha is not the run's clean deploy of it.
    ? status === "live" && d === currentLive && !!d.dirty === !!m.dirty
    : (!changes && (!push || (!d.dirty && d === runningNow && !overDevPush))) || (!!m.event_id && d.event_ids.some((e) => String(e) === String(m.event_id))));

  const same = ownNamed || ownRun || recent.find((d) =>
    d.target === target && (liveMatch(d) || OPEN.has(d.status)) && runFree(d)
    && (!d.repository || !repository || d.repository === repository)
    && ((m.sha && sameSha(d.sha, m.sha)) || (!m.sha && m.version && d.version === m.version)),
  );
  const open = same ?? recent.find((d) =>
    d.target === target && OPEN.has(d.status) && now - d.created_at < OPEN_DEPLOY_MAX_AGE_MS && runFree(d)
    && (!d.repository || !repository || d.repository === repository)
    // A deploy asked for at an earlier sha (a redeploy, a rollback) is finished only by its own sha.
    && (!d.action || d.action === "deploy" || !d.sha || (m.sha && sameSha(d.sha, m.sha)))
    // A run's marker finishes an open deploy only when it ships that deploy's sha, or the deploy names none yet.
    && (!m.workflow_run || !d.sha || (m.sha && sameSha(d.sha, m.sha))),
  );

  // The same failure reported again (a redelivery, a backfill) enriches the failed deploy it already recorded.
  const failedBefore = !open && !m.workflow_run && status === "failed" && m.sha
    ? recent.find((d) => d.target === target && d.status === "failed" && sameSha(d.sha, m.sha) && (!d.repository || !repository || d.repository === repository))
    : null;
  if (failedBefore) {
    const patch: Partial<Doc<"deploys">> = {};
    if (m.note && !failedBefore.note) patch.note = m.note.slice(-NOTE_MAX);
    if (m.url && !failedBefore.url) Object.assign(patch, urlFields(m.url));
    if (Object.keys(patch).length) await ctx.db.patch(failedBefore._id, { ...patch, updated_at: now });
    return failedBefore.short_id;
  }

  if (open) {
    const patch: Partial<Doc<"deploys">> = { updated_at: now };
    if (m.event_id && !open.event_ids.some((e) => String(e) === String(m.event_id))) patch.event_ids = [...open.event_ids, m.event_id];
    if (finishable(open)) {
      if (status === "running") patch.status = "running";
      else { patch.status = status; patch.finished_at = now; if (status === "live") patch.live_at = m.at; }
      if (open.superseded_by) patch.superseded_by = undefined;
    }
    // The deploy path that names its deploy, or a run whose name now names its commit, says what actually went out;
    // otherwise the first sha stands.
    const says = (ownNamed && (open.action ?? "deploy") === "deploy") || (m.sha_named && open === ownRun);
    if (m.sha && (!open.sha || (says && !sameSha(open.sha, m.sha)))) patch.sha = m.sha;
    if (m.note && !open.note) patch.note = m.note.slice(-NOTE_MAX);
    if (m.dirty && !open.dirty) patch.dirty = m.dirty;
    if (m.ship_pass_id && !open.ship_pass_id) patch.ship_pass_id = m.ship_pass_id;
    if (m.version && !open.version) patch.version = m.version;
    if (repository && !open.repository) patch.repository = repository;
    if (m.url && !open.url) Object.assign(patch, urlFields(m.url));
    if (m.previous_sha && !open.previous_sha) patch.previous_sha = m.previous_sha;
    if (m.commits?.length && !open.commits?.length) patch.commits = m.commits.slice(0, COMMITS_MAX);
    if (m.source_id && !open.source_id) patch.source_id = m.source_id;
    if (machine && !open.machine) patch.machine = machine;
    if (m.pushed_via && !open.pushed_via) patch.pushed_via = m.pushed_via;
    if (adds) patch.adds = capNames(open.adds, adds);
    if (drops) patch.drops = capNames(open.drops, drops);
    if (m.changes_read_at != null) patch.changes_read_at = Math.max(open.changes_read_at ?? 0, m.changes_read_at);
    await ctx.db.patch(open._id, patch);
    await stampEvent(ctx, m.event_id, open.short_id);
    if (patch.status && patch.status !== open.status) await onDeployStatus(ctx, open._id);
    // Whoever pushed is the dropper, not whoever asked for the deploy the push finished (a role, another person).
    if (patch.drops && (patch.status ?? open.status) === "live") await scheduleDroppedWork(ctx, deployDropper({ ...open, ...patch }), newNames(patch.drops, open.drops), m.started_by);
    return open.short_id;
  }

  const shortId = await nextShortId(ctx.db, DEPLOY_SHORT_ID_PREFIX);
  const base = {
    short_id: shortId,
    workspace: m.workspace,
    ...(m.team_id ? { team_id: m.team_id } : {}),
    ...(m.project_id ? { project_id: m.project_id } : {}),
    target,
    status,
    trigger: "outside" as const,
    ...(m.started_by ? { started_by: m.started_by } : {}),
    source: m.source,
    ...(m.source_id ? { source_id: m.source_id } : {}),
    event_ids: m.event_id ? [m.event_id] : [],
    ...(repository ? { repository } : {}),
    ...(m.sha ? { sha: m.sha } : {}),
    ...(m.previous_sha ? { previous_sha: m.previous_sha } : {}),
    ...(m.version ? { version: m.version } : {}),
    ...(m.url ? urlFields(m.url) : {}),
    ...(m.commits?.length ? { commits: m.commits.slice(0, COMMITS_MAX) } : {}),
    ...(m.note ? { note: m.note.slice(-NOTE_MAX) } : {}),
    ...(m.dirty ? { dirty: m.dirty } : {}),
    ...(m.ship_pass_id ? { ship_pass_id: m.ship_pass_id } : {}),
    ...(machine ? { machine } : {}),
    ...(m.pushed_via ? { pushed_via: m.pushed_via } : {}),
    ...(adds ? { adds } : {}),
    ...(drops ? { drops } : {}),
    ...(m.changes_read_at != null ? { changes_read_at: m.changes_read_at } : {}),
    carries: [],
    created_at: Math.min(m.started_at ?? m.at, m.at),
    ...(status === "live" ? { live_at: m.at } : {}),
    ...(status !== "running" ? { finished_at: m.at } : {}),
    updated_at: now,
  };
  const id = await ctx.db.insert("deploys", base);
  const row = (await ctx.db.get(id))!;
  if (status === "live") {
    const carries = await carriesForMarker(ctx, row, now);
    if (carries.length) await ctx.db.patch(id, { carries });
  }
  await stampEvent(ctx, m.event_id, shortId);
  await onDeployStatus(ctx, id);
  if (status === "live") await scheduleDroppedWork(ctx, deployDropper(row), drops ?? [], m.started_by);
  return shortId;
}

/** The push whose drops are told: a deploy (`deploy`, dp-N) or a dev push (`deploy` null), and the row it is (`exclude`). */
export type Dropper = {
  workspace: string;
  target: string;
  repository?: string;
  machine?: string;
  deploy: string | null;
  /** A dev push's target's live deploy (dp-N), which it runs on top of: where a phone opens the notice. */
  on?: string | null;
  exclude: string;
};

const startedByArg = v.object({
  kind: v.union(v.literal("person"), v.literal("role"), v.literal("line"), v.literal("source"), v.literal("cli")),
  name: v.string(),
  user_id: v.optional(v.id("users")),
  role_id: v.optional(v.id("org_roles")),
});

/** noticeDroppedWork, run after the push's own transaction (scheduleDroppedWork). */
export const tellDroppedWork = internalMutation({
  args: {
    dropper: v.object({
      workspace: v.string(),
      target: v.string(),
      repository: v.optional(v.string()),
      machine: v.optional(v.string()),
      deploy: v.union(v.string(), v.null()),
      on: v.optional(v.union(v.string(), v.null())),
      exclude: v.string(),
    }),
    names: v.array(v.string()),
    by: v.optional(startedByArg),
  },
  handler: async (ctx, args) => noticeDroppedWork(ctx, args.dropper, args.names, args.by),
});

/**
 * Tell people a push dropped their work in a transaction of its own, after the push's: a throw or a read limit there
 * never loses the push's record.
 */
async function scheduleDroppedWork(ctx: any, d: Dropper, names: ReadonlyArray<string>, by: StartedBy): Promise<void> {
  if (!names.length) return;
  const dropper = {
    workspace: d.workspace,
    target: d.target,
    ...(d.repository ? { repository: d.repository } : {}),
    ...(d.machine ? { machine: d.machine } : {}),
    deploy: d.deploy,
    ...(d.on !== undefined ? { on: d.on } : {}),
    exclude: d.exclude,
  };
  await ctx.scheduler.runAfter(0, internal.deploys.tellDroppedWork, { dropper, names: [...names], ...(by ? { by } : {}) });
}

const deployDropper = (d: Doc<"deploys">): Dropper => ({ workspace: d.workspace, target: d.target, repository: d.repository, machine: d.machine, deploy: d.short_id, exclude: String(d._id) });

/**
 * A push took names off its target: each person whose uncommitted push put one
 * there hears it. A name's adder is the latest other push of the target (and
 * repository), a deploy or a dev push, whose adds hold it (adderOf), counted
 * only when that push was a dev push or a dirty deploy and no clean deploy
 * whose diff read prod after it kept the name: what a commit holds and a later
 * push took off was the commits' decision, not lost work. `by` is who pushed
 * (not who asked for the deploy the push finished): they are not told about
 * their own, nobody outside the push's workspace is told, and a person this
 * pusher's drops reached in the last DROPPED_WORK_QUIET_MS is not told again
 * about the same pusher's drops of the same kind (a deploy's, a dev push's):
 * two watchers on different trees drop each other's work on every save.
 * Another pusher's drop is told, and so is a deploy's after a dev push's.
 */
export async function noticeDroppedWork(ctx: any, d: Dropper, names: ReadonlyArray<string>, by: StartedBy): Promise<void> {
  if (!names.length) return;
  const pushes = (await targetPushes(ctx, d.workspace, d.target, d.repository ?? null)).filter((p) => String(p.row._id) !== d.exclude);
  const self = by?.user_id ? String(by.user_id) : null;
  const people = new Map<string, { user_id: Id<"users">; deploys: Set<string>; devPushes: Set<string>; names: string[] }>();
  const member = new Map<string, boolean>();
  for (const name of names) {
    const found = adderOf(pushes, name);
    if (!found || found.committed_in) continue;
    const { adder } = found;
    if (adder.kind === "deploy" && !((adder.row.dirty ?? 0) > 0)) continue;
    const userId = adder.row.started_by?.user_id;
    if (!userId || String(userId) === self) continue;
    // Someone who has left the team that owns the push no longer reads its names.
    if (!member.has(String(userId))) member.set(String(userId), await workspaceGrantsAccess(ctx, userId, d.workspace));
    if (!member.get(String(userId))) continue;
    const entry = people.get(String(userId)) ?? { user_id: userId, deploys: new Set<string>(), devPushes: new Set<string>(), names: [] };
    if (adder.kind === "deploy") entry.deploys.add(adder.row.short_id);
    else entry.devPushes.add(String(adder.row._id));
    entry.names.push(name);
    people.set(String(userId), entry);
  }
  const since = Date.now() - DROPPED_WORK_QUIET_MS;
  const dropperName = d.deploy ?? `${by?.name ?? "Someone"}'s dev push${d.machine ? ` from ${d.machine}` : ""}`;
  // A deploy's notice opens the deploy; a dev push has no page of its own, so its notice opens the Deploys page. The
  // link is what tells a notice's kind of dropper apart.
  const link = d.deploy ? `/deploys?deploy=${d.deploy}` : "/deploys";
  const sameKind = (n: Doc<"notifications">) => (n.link === "/deploys") === !d.deploy;
  for (const p of people.values()) {
    const recent: Doc<"notifications">[] = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_created", (q: any) => q.eq("recipient_user_id", p.user_id).gte("created_at", since))
      .order("desc")
      .take(DROPPED_WORK_QUIET_SCAN);
    // The same pusher, by account, else by the name a pusher without one (a role, a source) is shown under.
    const told = recent.some((n) => n.type === "deploy_dropped_work" && sameKind(n)
      && (by?.user_id ? String(n.actor_user_id) === String(by.user_id) : n.actor_name === by?.name));
    if (told) continue;
    const n = p.names.length;
    const shown = p.names.slice(0, 5).join(", ") + (n > 5 ? ` and ${n - 5} more` : "");
    const deploys = [...p.deploys];
    const yours = [
      p.devPushes.size ? `dev push${p.devPushes.size === 1 ? "" : "es"}` : null,
      deploys.length ? `uncommitted push${deploys.length === 1 ? "" : "es"} ${deploys.join(", ")}` : null,
    ].filter(Boolean).join(" and ");
    await emitNotification(ctx, {
      event_type: "deploy_dropped_work",
      ...(by?.user_id ? { actor_user_id: by.user_id } : {}),
      ...(by?.name ? { actor_name: by.name } : {}),
      // A dev push's notice names the deploy it ran on top of, for a reader (the phone) with no Deploys list.
      entity_type: "deploy",
      entity_id: d.deploy ?? d.on ?? "",
      link,
      message: `${dropperName} dropped ${n} thing${n === 1 ? "" : "s"} your ${yours} put on ${d.target}: ${shown}`,
      recipient_ids: [p.user_id],
    });
  }
}

/**
 * A deploy that just went live or failed: a live one fills its range on main
 * (deployTargets.fillDeployRange), and either fires its trigger event
 * (deploy_live, deploy_failed) for the team's triggers.
 */
async function onDeployStatus(ctx: any, id: Id<"deploys">): Promise<void> {
  const d: Doc<"deploys"> | null = await ctx.db.get(id);
  if (!d || (d.status !== "live" && d.status !== "failed")) return;
  if (d.status === "live") {
    await fillDeployRange(ctx, id);
    await closeSuperseded(ctx, d);
  }
  const sha = d.sha ? ` at ${d.sha.slice(0, 7)}` : d.version ? ` ${d.version}` : "";
  const title = d.status === "live" ? `${d.short_id} live on ${d.target}${sha}` : `${d.short_id} to ${d.target}${sha} failed`;
  await scheduleTriggerMatch(ctx, {
    event_type: d.status === "live" ? DEPLOY_LIVE_EVENT : DEPLOY_FAILED_EVENT,
    ...(d.team_id ? { team_id: d.team_id } : {}),
    workspace: d.workspace,
    ...(d.repository ? { repository: d.repository } : {}),
    source: d.target,
    event_ref: { title, ...(d.url ? { url: d.url } : {}) },
  });
}

async function stampEvent(ctx: any, eventId: Id<"external_events"> | undefined, shortId: string): Promise<void> {
  if (!eventId) return;
  const e = await ctx.db.get(eventId);
  if (!e || e.meta?.deploy === shortId) return;
  await ctx.db.patch(eventId, { meta: { ...(e.meta ?? {}), deploy: shortId } });
}

// ── the line's deploy stage (DP2) ────────────────────────────────────────────

/** A project by name in any of the caller's workspaces, when a profile names no team; two matches ask for the team. */
async function projectByNameAnywhere(ctx: any, userId: Id<"users">, name: string): Promise<Doc<"projects"> | null> {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).take(50);
  const keys = [`user:${userId}`, ...memberships.map((m: any) => `team:${m.team_id}`)];
  const found: Doc<"projects">[] = [];
  for (const k of keys) {
    // A workspace without the project answers by throwing; only a match counts.
    const p = await resolveWorkspaceProject(ctx, k, name).catch(() => null);
    if (p) found.push(p);
  }
  if (found.length > 1) throw new Error(`More than one of your workspaces has a project named ${name}; set [line] team in .codecast/line.toml`);
  return found[0] ?? null;
}

/** A project by id, short id, or (with the profile's team) its name. */
async function readableProjectFor(ctx: any, userId: Id<"users">, projectRef: string, teamId?: Id<"teams">): Promise<Doc<"projects">> {
  const id = ctx.db.normalizeId("projects", projectRef);
  const project = id
    ? await ctx.db.get(id)
    : (await ctx.db.query("projects").withIndex("by_short_id", (q: any) => q.eq("short_id", projectRef)).first())
      ?? (teamId ? await resolveWorkspaceProject(ctx, `team:${teamId}`, projectRef) : await projectByNameAnywhere(ctx, userId, projectRef));
  if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project ${projectRef} you can read`);
  return project;
}

async function personName(ctx: any, userId: Id<"users">): Promise<string> {
  const u = await ctx.db.get(userId);
  return u?.name ?? u?.github_username ?? u?.email ?? "someone";
}

/**
 * The deploy stage of a project's line: the shipped fixes waiting to go out,
 * the deploy already on its way, and the profile's deploy path.
 */
export const stage = query({
  args: { project_id: v.string(), team_id: v.optional(v.id("teams")), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const project = await readableProjectFor(ctx, userId, args.project_id, args.team_id);
    const workspace = await resolveWorkspaceKey(ctx, project);
    const now = Date.now();
    const { waiting, open } = await waitingFor(ctx, project, workspace, now);
    const tasks = new Map<string, any>();
    for (const m of waiting) if (!tasks.has(m.task_id)) tasks.set(m.task_id, await ctx.db.get(m.task_id as Id<"tasks">));
    const profile: any = project.line_profile ?? null;
    return {
      project: { _id: String(project._id), short_id: project.short_id ?? null, title: project.title ?? null },
      deploy: profile?.deploy ?? null,
      device_id: profile?.device_id ?? null,
      root: profile?.root ?? null,
      waiting: waiting.map((m) => ({ ...m, task_short_id: tasks.get(m.task_id)?.short_id ?? null, task_title: tasks.get(m.task_id)?.title ?? null })),
      open: open ? await shapeView(ctx, open) : null,
      auto: await deployAutoOf(ctx, project, now),
    };
  },
});

/** Who asks for a deploy: a person (the Deploy button, the CLI) or the role the profile names (DP4). */
type DeployAsker =
  | { kind: "person"; userId: Id<"users">; cli: boolean }
  | { kind: "role"; role: Doc<"org_roles"> };

/**
 * Ask for one deploy that sends the project's waiting fixes together. The web
 * path also queues `line_deploy` on the machine that publishes the profile;
 * the CLI path (`here`) runs the command itself. `clientKey` is the store's
 * stub of the row, which the server row supersedes (lineDeploys altKey).
 */
export async function requestDeployCore(
  ctx: any,
  userId: Id<"users">,
  projectRef: string,
  opts: { teamId?: Id<"teams">; here?: boolean; cli?: boolean; clientKey?: string; requestId?: string } = {},
): Promise<{ _id: string; short_id: string; carries: number }> {
  const project = await readableProjectFor(ctx, userId, projectRef, opts.teamId);
  return await askForDeploy(ctx, project, { kind: "person", userId, cli: !!opts.cli }, opts);
}

async function askForDeploy(
  ctx: any,
  project: Doc<"projects">,
  asker: DeployAsker,
  opts: { here?: boolean; clientKey?: string; requestId?: string; now?: number } = {},
): Promise<{ _id: string; short_id: string; carries: number }> {
  const profile: any = project.line_profile ?? null;
  const deploy = profile?.deploy;
  if (!deploy?.command) throw new Error("This line has no deploy stage: add [line.deploy] command to .codecast/line.toml and publish it");
  const workspace = await resolveWorkspaceKey(ctx, project);
  const now = opts.now ?? Date.now();
  const { waiting, open } = await waitingFor(ctx, project, workspace, now);
  if (open) throw new Error(`${open.short_id} is already going out (${open.status}); wait for it to finish`);
  if (!waiting.length) throw new Error("Nothing is waiting to go out: every shipped fix is live");
  if (!opts.here && (!profile.device_id || !profile.root)) throw new Error("No machine publishes this flow's profile, so nothing can run its deploy path");

  const shortId = await nextShortId(ctx.db, DEPLOY_SHORT_ID_PREFIX);
  const startedBy = asker.kind === "role"
    ? { kind: "role" as const, name: `@${asker.role.handle}`, role_id: asker.role._id }
    : { kind: asker.cli ? "cli" as const : "person" as const, name: await personName(ctx, asker.userId), user_id: asker.userId };
  const id = await ctx.db.insert("deploys", {
    short_id: shortId,
    ...(opts.clientKey ? { client_key: opts.clientKey } : {}),
    workspace,
    ...(project.team_id ? { team_id: project.team_id } : {}),
    project_id: project._id,
    target: normalizeDeployTarget(deploy.target) ?? "deploy",
    status: "requested",
    trigger: asker.kind,
    started_by: startedBy,
    source: "line",
    event_ids: [],
    carries: waiting.map((m) => ({
      task_id: m.task_id as Id<"tasks">,
      ...(runIdOf(m.run_id) ? { run_id: runIdOf(m.run_id) } : {}),
      ...(m.decision_id ? { decision_id: m.decision_id as Id<"session_decisions"> } : {}),
      merge_sha: m.sha,
      merged_at: m.at,
      ...(m.pr_url ? { pr_url: m.pr_url } : {}),
      how: "sent" as const,
    })),
    created_at: now,
    updated_at: now,
  });
  if (!opts.here) {
    // A person's press runs on their own machine; the role's runs on the
    // machine of whoever published the profile, the checkout the path lives in.
    const runner = asker.kind === "person" ? asker.userId : (profile.publisher_user_id as Id<"users">);
    try {
      await enqueueConfigCommand(ctx, runner, "line_deploy", JSON.stringify({ deploy: shortId, root: profile.root }), profile.device_id, opts.requestId);
    } catch (err) {
      throw new Error(`The deploy runs on the machine that publishes this flow, which is not yours: ask its owner, or run \`cast flow deploy --go\` there (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { _id: String(id), short_id: shortId, carries: waiting.length };
}

/** The role a profile's `[line.deploy] role` names, in the project's team (DP4). */
async function deployRoleOf(ctx: any, project: Doc<"projects">): Promise<Doc<"org_roles"> | null> {
  const deploy: any = (project as any).line_profile?.deploy;
  const handle = deploy?.trigger === "role" ? normalizeRoleHandle(deploy.role) : null;
  if (!handle) return null;
  return await liveRoleByHandle(ctx, project.team_id ? { team_id: project.team_id } : { scope_user_id: project.user_id }, handle);
}

/** What the role trigger reads on a project's stage: the role, whether it may deploy now, and why not. */
export type DeployAuto = { role: string; role_id: string | null; allowed: boolean; reason: string | null; used: number; limit: number | null };

async function deployAutoOf(ctx: any, project: Doc<"projects">, now: number): Promise<DeployAuto | null> {
  const deploy: any = (project as any).line_profile?.deploy;
  if (deploy?.trigger !== "role") return null;
  const role = await deployRoleOf(ctx, project);
  if (!role) return { role: normalizeRoleHandle(deploy.role) ?? "", role_id: null, allowed: false, reason: `no role @${normalizeRoleHandle(deploy.role)} in this team`, used: 0, limit: null };
  const a: DeployAllowance = deployAllowance(role, now);
  return { role: role.handle, role_id: String(role._id), allowed: a.allowed, reason: a.reason, used: a.used, limit: a.limit };
}

export type AutoDeployResult = { asked: Array<{ project_id: string; deploy: string; role: string }>; waiting: Array<{ project_id: string; why: string }> };

/**
 * The role trigger (DP4). For every project whose profile names
 * `trigger = "role"`, the role asks for a deploy when fixes wait, nothing is
 * going out, the newest waiting fix has settled (DEPLOY_SETTLE_MS) and its
 * deploy grant has room today. The ask counts against the grant's daily
 * limit and is told to the role in one line. A project the role cannot
 * deploy is reported with why and asks nobody.
 */
export async function autoDeployCore(ctx: any, now = Date.now()): Promise<AutoDeployResult> {
  const out: AutoDeployResult = { asked: [], waiting: [] };
  // Only a role holding a deploy grant can deploy, so the pass starts from those few and reads their teams' projects.
  const granted: Doc<"org_roles">[] = (await ctx.db.query("org_roles").collect()).filter((r: any) => r.status === "active" && deployGrantOf(r, now));
  const projects: Doc<"projects">[] = [];
  for (const team of new Set(granted.map((r) => r.team_id).filter(Boolean).map(String))) {
    const rows = await ctx.db.query("projects").withIndex("by_team_id", (q: any) => q.eq("team_id", team)).collect();
    projects.push(...rows.filter((p: any) => p.line_profile?.deploy?.trigger === "role" && p.line_profile?.deploy?.command));
  }
  for (const project of projects) {
    const projectId = String(project._id);
    const role = await deployRoleOf(ctx, project);
    if (!role) { out.waiting.push({ project_id: projectId, why: "no such role" }); continue; }
    const allowance = deployAllowance(role, now);
    const workspace = await resolveWorkspaceKey(ctx, project);
    const { waiting, open } = await waitingFor(ctx, project, workspace, now);
    if (open || !waiting.length) continue;
    if (!allowance.allowed) { out.waiting.push({ project_id: projectId, why: allowance.reason ?? "not allowed" }); continue; }
    const newest = Math.max(...waiting.map((m) => m.at));
    if (now - newest < DEPLOY_SETTLE_MS) { out.waiting.push({ project_id: projectId, why: "settling" }); continue; }
    // A failed deploy came back to the line as a problem: the role sends again once a newer fix lands (or a person presses Deploy).
    const last = (await workspaceDeploys(ctx, workspace, 20)).find((d) => inScope(d, projectId, null) && d.source === "line");
    if (last?.status === "failed" && newest <= last.created_at) { out.waiting.push({ project_id: projectId, why: `${last.short_id} failed; waiting for a new fix` }); continue; }
    let asked;
    try {
      asked = await askForDeploy(ctx, project, { kind: "role", role }, { now });
    } catch (err) {
      out.waiting.push({ project_id: projectId, why: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const counters = countersFor(role, now);
    const used = (counters.deploys ?? 0) + 1;
    await ctx.db.patch(role._id, { counters: { ...counters, deploys: used }, updated_at: now });
    const target = normalizeDeployTarget((project as any).line_profile.deploy.target) ?? "deploy";
    await tellRole(ctx, role._id, {
      content: `[flow] I asked for ${asked.short_id}: ${asked.carries} shipped fix${asked.carries === 1 ? "" : "es"} of ${project.title ?? "the flow"} going out to ${target}, deploy ${used} of ${allowance.limit} today. Its steps run as the line's deploy stations; a step that fails comes back as a problem on the line.`,
      client_id: `line-deploy:${asked.short_id}`,
    });
    out.asked.push({ project_id: projectId, deploy: asked.short_id, role: role.handle });
  }
  return out;
}

export const autoDeploy = internalMutation({
  args: {},
  handler: async (ctx) => autoDeployCore(ctx),
});

export const request = mutation({
  args: {
    project_id: v.string(),
    team_id: v.optional(v.id("teams")),
    api_token: v.optional(v.string()),
    here: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    return await requestDeployCore(ctx, userId, args.project_id, { teamId: args.team_id, here: args.here, cli: !!args.api_token });
  },
});

/** The deploy path's report: started (running, with its run's url), done (live, with the sha it put out) or failed. */
export const report = mutation({
  args: {
    api_token: v.optional(v.string()),
    deploy: v.string(),
    status: v.union(v.literal("running"), v.literal("live"), v.literal("failed"), v.literal("cancelled")),
    sha: v.optional(v.string()),
    previous_sha: v.optional(v.string()),
    url: v.optional(v.string()),
    note: v.optional(v.string()),
    commits: v.optional(v.array(v.object({ sha: v.string(), subject: v.string(), author: v.optional(v.string()), conversation_id: v.optional(v.id("conversations")) }))),
    // Files under the target's sources that went out uncommitted.
    dirty: v.optional(v.number()),
    // The line-deploy run carrying it (DP8), named once when the run begins.
    run_id: v.optional(v.string()),
    // The watch station's live report: the carried fixes are watched for this many days from now (DP8).
    watch_days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await deployByRef(ctx, args.deploy);
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) throw new Error(`No deploy ${args.deploy} you can read`);
    const now = Date.now();
    const patch: Partial<Doc<"deploys">> = { updated_at: now };
    // A run another deploy already carries (its own marker recorded it at the sha it shipped) stays that deploy's.
    const run = args.url ? actionsRunKey(args.url) : null;
    const taken = run ? (await deploysOfRun(ctx, run)).some((x) => String(x._id) !== String(d._id)) : false;
    if (args.url && !taken) Object.assign(patch, urlFields(args.url));
    if (args.sha && !d.sha) patch.sha = args.sha.toLowerCase();
    if (args.previous_sha && !d.previous_sha) patch.previous_sha = args.previous_sha.toLowerCase();
    if (args.commits?.length && !d.commits?.length) patch.commits = args.commits.slice(0, COMMITS_MAX);
    if (args.note) patch.note = args.note.slice(-NOTE_MAX);
    if (args.dirty && !d.dirty) patch.dirty = args.dirty;
    const runId = args.run_id ? ctx.db.normalizeId("workflow_runs", args.run_id) : null;
    if (runId && !d.run_id) patch.run_id = runId;
    // A marker may have finished it already; a report never moves a deploy backwards.
    if (finishable(d)) {
      if (args.status === "running") patch.status = "running";
      else {
        patch.status = args.status;
        patch.finished_at = now;
        if (args.status === "live") patch.live_at = now;
      }
      if (d.superseded_by) patch.superseded_by = undefined;
    }
    await ctx.db.patch(d._id, patch);
    if (patch.status && patch.status !== d.status) await onDeployStatus(ctx, d._id);
    if (args.status === "live" && args.watch_days && (patch.status ?? d.status) === "live") {
      const live = patch.live_at ?? d.live_at ?? now;
      await watchFromLive(ctx, d, live, live + args.watch_days * DAY);
    }
    return { short_id: d.short_id, status: patch.status ?? d.status };
  },
});

/**
 * A fix is in production only once its deploy is live, so its watch (LE12)
 * runs from then: each carried problem that shipped (done, or still in its
 * watch) is watched until `until`, never shortened, and only evidence from
 * after `live` reopens it (signals.ts watchReopens).
 */
async function watchFromLive(ctx: any, d: Doc<"deploys">, live: number, until: number, only?: ReadonlySet<string>, dry = false): Promise<Array<{ task: string; watch_from: number | null; watch_until: number | null }>> {
  const moved: Array<{ task: string; watch_from: number | null; watch_until: number | null }> = [];
  for (const c of d.carries) {
    const task = await ctx.db.get(c.task_id);
    if (!task || task.status !== "done" || (only && !only.has(task.short_id))) continue;
    if ((task.watch_until ?? 0) >= until) continue;
    moved.push({ task: task.short_id, watch_from: task.watch_from ?? null, watch_until: task.watch_until ?? null });
    if (!dry) await ctx.db.patch(task._id, { watch_from: live, watch_until: until });
  }
  return moved;
}

/**
 * Repair (ct-86011): a fix whose line closed it Done at the merge started its watch then, before any deploy took it
 * live. Its watch runs from the live deploy that carried it instead (watchFromLive), for the problems named, and
 * `dry` lists what would move without writing. Run with packages/convex/run.sh.
 */
export const rewatchFromLive = internalMutation({
  args: { deploy: v.string(), tasks: v.array(v.string()), watch_days: v.number(), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const d = await deployByRef(ctx, args.deploy);
    if (!d || d.status !== "live" || !d.live_at) throw new Error(`${args.deploy} is not a live deploy`);
    const moved = await watchFromLive(ctx, d, d.live_at, d.live_at + args.watch_days * DAY, new Set(args.tasks), !!args.dry);
    return { deploy: d.short_id, live_at: d.live_at, dry: !!args.dry, moved };
  },
});

/** A deploy's url, with the Actions run it names stamped beside it. */
export function urlFields(url: string): Pick<Doc<"deploys">, "url" | "workflow_run"> {
  const run = actionsRunKey(url);
  return { url, ...(run ? { workflow_run: run } : {}) };
}

/** The deploys an Actions run carried (one per target that runs it; normally one). */
export async function deploysOfRun(ctx: any, run: string): Promise<Doc<"deploys">[]> {
  return await ctx.db.query("deploys").withIndex("by_workflow_run", (q: any) => q.eq("workflow_run", run)).take(10);
}

/** A deploy by its dp-N or its id. */
async function deployByRef(ctx: any, ref: string): Promise<Doc<"deploys"> | null> {
  if (DEPLOY_SHORT_ID_RE.test(ref)) return await ctx.db.query("deploys").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.toLowerCase())).first();
  const id = ctx.db.normalizeId("deploys", ref);
  return id ? await ctx.db.get(id) : null;
}

// ── reads ────────────────────────────────────────────────────────────────────

/** One deploy, whole: what went out, who started it, what happened after. */
export const get = query({
  args: { ref: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const ref = args.ref.trim();
    // A run's url, or its bare id (run ids are GitHub-wide): the deploy it carried that this viewer can read.
    const run = actionsRunKey(ref) ?? (/^\d{9,}$/.test(ref) ? ref : null);
    let d: Doc<"deploys"> | null = null;
    if (run) {
      const repository = normalizeRepository(/github\.com\/([^/\s]+\/[^/\s]+)\/actions\//i.exec(ref)?.[1] ?? "");
      for (const x of await deploysOfRun(ctx, run)) {
        if (!d && (!repository || !x.repository || x.repository === repository) && (await workspaceGrantsAccess(ctx, userId, x.workspace))) d = x;
      }
    } else {
      d = await deployByRef(ctx, ref);
      if (d && !(await workspaceGrantsAccess(ctx, userId, d.workspace))) d = null;
    }
    if (!d) return null;
    const around = (await workspaceDeploys(ctx, d.workspace)).filter((x) => x.target === d.target);
    const after = await afterFor(ctx, d.workspace, around.some((x) => String(x._id) === String(d._id)) ? around : [...around, d], Date.now());
    const events = [];
    for (const e of d.event_ids) {
      const row = await ctx.db.get(e);
      if (row) events.push({ _id: String(row._id), title: row.title, url: row.url ?? null, at: row.created_at, source: row.data?.source_name ?? row.source });
    }
    const project = d.project_id ? await ctx.db.get(d.project_id) : null;
    // A live deploy that is no longer what runs: the deploy that went live after it on its target.
    const wentLive = d.live_at ?? d.created_at;
    const replacer = d.status === "live"
      ? liveDeploys(around, { repository: d.repository }).filter((x) => (x.live_at ?? x.created_at) > wentLive || ((x.live_at ?? x.created_at) === wentLive && x._creationTime > d._creationTime)).at(-1)
      : undefined;
    return {
      ...(await shapeView(ctx, d)),
      after: after.get(String(d._id)) ?? null,
      replaced_by: replacer ? { short_id: replacer.short_id, sha: replacer.sha ?? null, at: replacer.live_at ?? replacer.created_at, rollback: replacer.action === "rollback" } : null,
      events,
      project: project ? { _id: String(project._id), short_id: project.short_id ?? null, title: project.title ?? null } : null,
    };
  },
});

/** The deploys that carried a problem's fixes, newest first: what the problem and its decision link to. */
export const forTask = query({
  args: { task_id: v.id("tasks") },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, undefined);
    const task = await ctx.db.get(args.task_id);
    if (!task) return [];
    const workspace = await resolveWorkspaceKey(ctx, task);
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return [];
    const deploys = await workspaceDeploys(ctx, workspace);
    return deploys
      .filter((d) => d.carries.some((c) => String(c.task_id) === String(args.task_id)))
      .map((d) => ({ _id: String(d._id), short_id: d.short_id, target: d.target, status: d.status, sha: d.sha ?? null, at: d.live_at ?? d.created_at }));
  },
});

/**
 * A project's deploys over the history window, newest first, each with what
 * it carried and what happened after: the rows the Line page, a problem's
 * timeline and the charts read (store collection lineDeploys).
 */
export async function projectDeployViews(ctx: any, project: Doc<"projects">, repositories: ReadonlyArray<string>, since: number) {
  const workspace = await resolveWorkspaceKey(ctx, project);
  const repos = repositories.length ? new Set(repositories.map((r) => normalizeRepository(r))) : null;
  const all = (await workspaceDeploys(ctx, workspace)).filter((d) => (d.live_at ?? d.created_at) >= since || OPEN.has(d.status));
  const mine = all.filter((d) => inScope(d, String(project._id), repos));
  const after = await afterFor(ctx, workspace, mine, Date.now());
  const out = [];
  for (const d of mine) {
    // A list row counts the names a push added and dropped; the deploy itself (deploys.get) lists them.
    const { adds, drops, ...view } = await shapeView(ctx, d);
    // One row per deploy, whichever project's feed brought it: its own project when the line sent it, none when it
    // ships the whole workspace's code. The store scopes rows by `workspace` (lineDeploys workspaceScoped).
    out.push({ ...deployRowOf(d), ...view, adds_count: adds?.length ?? 0, drops_count: drops?.length ?? 0, workspace: d.workspace, after: after.get(String(d._id)) ?? null });
  }
  return out;
}
