// Where a line run works (the-line-end-to-end.md LE6): the runner's machines
// that offer a checkout of the role's repository (devices.line_slots), each
// with its own number of runs at once. The role's folder names the checkout
// on the machine it was seated from; its origin, read from that machine's git
// plane, names the repository, and the subpath under the repository root
// names the same folder on every machine in the pool.
//
// A runner with no such machine takes the team's pool: the machines any member
// of the role's team offers for that repository. A run placed on another
// account's machine runs and bills as that account, the way any session placed
// on a teammate's machine does, and the seat's person stays its owner, so its
// cards reach who they reach on the seat's own machine (orgLine.startRoleRun).
import { fromConvexAgentType, normalizeGitOrigin, pathUnderRoot, signedOutAgents } from "@codecast/shared/contracts";
import { isDeviceOnline } from "../ccAccountsShared";

type Ctx = { db: any };

export type LineSlot = { device: string; user: string; root: string; runs: number; working: number };
/** `offline`: the machines that hold a slot for the checkout and are offline now (or cannot start the flow's agents). */
export type LinePool = { origin: string; subpath: string; slots: LineSlot[]; offline?: number };

// A run works while it is pending or running. A run paused at its card, or
// running but blocked on a person's answer, uses no machine.
export const WORKING_RUN_STATUSES = ["pending", "running"] as const;

/** Runs of `runner` that wait on a blocking decision: they hold no slot. */
export async function runsWaitingOnAPerson(ctx: Ctx, runner: string): Promise<Set<string>> {
  const asked: any[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", runner).eq("status", "pending"))
    .collect();
  return new Set(asked.filter((d) => d.blocking && d.workflow_run_id).map((d) => String(d.workflow_run_id)));
}

/**
 * Whether a line run uses a machine slot: a role's run (a cause's, or a judge
 * diagnosis with no task) or any run with a task, unless it is parked. A run
 * at a blocking decision is parked (`waiting`, runsWaitingOnAPerson), and so
 * is one whose task holds an open wait (a time, a PR, a decision:
 * task-graph.md TG2): its hand sleeps until the wait clears, like a run at a
 * card, and the runner does not kill it at the node's timeout. So is a run at
 * a station its flow marks `parks` (a wait for an eval wallet's room): it takes
 * a slot again once it moves on.
 */
export async function holdsSlot(ctx: Ctx, run: any, waiting: Set<string>): Promise<boolean> {
  if (!(run.org_role_id || run.task_id) || waiting.has(String(run._id))) return false;
  if (await parkedAtStation(ctx, run)) return false;
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  return !task?.waiting_since;
}

// The stations that park in each flow version, read once: a version never
// changes, and its snapshot is the whole flow, too large to read per run.
const parkingStations = new Map<string, Set<string>>();

/** Whether `run` stands at a station that parks in a flow version it is pinned to. */
async function parkedAtStation(ctx: Ctx, run: any): Promise<boolean> {
  if (!run.current_node_id) return false;
  for (const fv of run.flow_versions ?? []) {
    const key = String(fv.version_id);
    let parks = parkingStations.get(key);
    if (!parks) {
      const id = ctx.db.normalizeId?.("workflow_versions", key) ?? key;
      const version = await ctx.db.get(id);
      if (!version) continue;
      parks = new Set((version.snapshot?.nodes ?? []).filter((n: any) => n.parks).map((n: any) => String(n.id)));
      parkingStations.set(key, parks);
    }
    if (parks.has(String(run.current_node_id))) return true;
  }
  return false;
}

/**
 * The agents a flow's stations start: each agent or prompt station's own, and the runner's default (Claude) for one
 * that names none, spelled as the runner spells them (cli runner.ts waitOnStation).
 */
export function flowAgents(nodes: readonly { type?: string; agent?: string }[] | null | undefined): string[] {
  const agents = (nodes ?? []).filter((n) => n.type === "agent" || n.type === "prompt").map((n) => fromConvexAgentType(String(n.agent || "claude").toLowerCase()));
  return [...new Set(agents)].sort();
}

/**
 * The first of `needs` a machine reports it cannot start (its CLI has no sign-in there: devices.cloud_agent_blocks),
 * and what it needs to: a run placed there would fail at that agent's station.
 */
export function missingAgentOn(device: { cloud_agent_blocks?: any[] | null }, needs: readonly string[] | undefined): { agent: string; login: string } | null {
  if (!needs?.length) return null;
  return signedOutAgents(device.cloud_agent_blocks).find((b) => needs.includes(b.agent)) ?? null;
}

/** The runs a device's line slot takes at once: none while an operator holds the device (linePool.holdLine). */
export const slotRuns = (device: { line_hold?: unknown }, slot: { runs: number }): number => (device.line_hold ? 0 : slot.runs);

/** The runner's devices that offer any line checkout: their runs are counted by the pool, not the runner's own cap. */
export async function poolDeviceIds(ctx: Ctx, runner: string): Promise<Set<string>> {
  const devices: any[] = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", runner)).collect();
  return new Set(devices.filter((d) => d.line_slots?.length).map((d) => String(d.device_id)));
}

/** The slots the runs on a machine use now: a run waiting on a person, parked, or with no role or task uses none. */
export async function deviceWorking(ctx: Ctx, device: string, waiting: Set<string>): Promise<number> {
  let working = 0;
  for (const status of WORKING_RUN_STATUSES) {
    const runs: any[] = await ctx.db
      .query("workflow_runs")
      .withIndex("by_runner_device_status", (q: any) => q.eq("runner_device", device).eq("status", status))
      .collect();
    for (const r of runs) if (await holdsSlot(ctx, r, waiting)) working++;
  }
  return working;
}

/** The members of a team, the people whose machines make up its line pool. */
async function teamMemberIds(ctx: Ctx, teamId: string): Promise<string[]> {
  const rows: any[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  return [...new Set(rows.map((m) => String(m.user_id)))];
}

/**
 * The pool for a role whose folder is `projectPath`: the runner's online machines that offer its repository, else,
 * when the runner has none and the role belongs to a team, the team's (every member's). Null when neither has one,
 * and the run stays on the runner's own machine. A machine that cannot start one of the agents the run's flow needs
 * (`needs`: flowAgents) is no slot of it, so a runner whose own machines all lack one takes the team's pool.
 */
export async function linePoolFor(ctx: Ctx, runner: string, projectPath: string | undefined, now: number, teamId?: string | null, needs?: readonly string[]): Promise<LinePool | null> {
  if (!projectPath) return null;
  const devices: any[] = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", runner)).collect();
  let checkout: { root: string; origin: string } | null = null;
  for (const d of devices) {
    for (const g of d.git_plane ?? []) {
      if (!g.origin || !pathUnderRoot(projectPath, g.root) || (checkout && checkout.root.length >= g.root.length)) continue;
      checkout = { root: g.root, origin: g.origin };
    }
  }
  const origin = checkout && normalizeGitOrigin(checkout.origin);
  if (!checkout || !origin) return null;
  const subpath = projectPath.slice(checkout.root.length).replace(/^\/+/, "");
  const own = await slotsFor(ctx, devices, origin, now, needs);
  const offline = (ds: any[]) => ds.filter((d) => (d.line_slots ?? []).some((s: any) => s.origin === origin) && (!isDeviceOnline(d, now) || missingAgentOn(d, needs))).length;
  if (own.length) return { origin, subpath, slots: own, offline: offline(devices) };
  if (!teamId) return null;
  const team: any[] = [];
  for (const member of await teamMemberIds(ctx, teamId)) {
    if (member === runner) continue;
    team.push(...await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", member)).collect());
  }
  const shared = await slotsFor(ctx, team, origin, now, needs);
  return shared.length ? { origin, subpath, slots: shared, offline: offline(devices) + offline(team) } : null;
}

async function slotsFor(ctx: Ctx, devices: any[], origin: string, now: number, needs?: readonly string[]): Promise<LineSlot[]> {
  const waiting = new Map<string, Set<string>>();
  const slots: LineSlot[] = [];
  for (const d of devices) {
    if (!isDeviceOnline(d, now) || missingAgentOn(d, needs)) continue;
    // A slot with no runs (a spent account, a full disk, an operator's hold) keeps its machine in the pool with no room,
    // so the run waits for a slot instead of falling back to the runner's own machine (Oct 24: 7 of 10 runs landed on
    // the laptop).
    const slot = (d.line_slots ?? []).find((s: any) => s.origin === origin);
    if (!slot) continue;
    const user = String(d.user_id);
    // A run's decisions are asked by its sessions, which run as the machine's account.
    if (!waiting.has(user)) waiting.set(user, await runsWaitingOnAPerson(ctx, user));
    slots.push({ device: String(d.device_id), user, root: slot.root, runs: slotRuns(d, slot), working: await deviceWorking(ctx, String(d.device_id), waiting.get(user)!) });
  }
  return slots;
}

export const poolFree = (pool: LinePool): number => pool.slots.reduce((n, s) => n + Math.max(0, s.runs - s.working), 0);
export const poolCap = (pool: LinePool): number => pool.slots.reduce((n, s) => n + s.runs, 0);
export const poolWorking = (pool: LinePool): number => pool.slots.reduce((n, s) => n + s.working, 0);

/** The slot with the most free runs, and the run's folder there; null when every slot is full. Counts the run on it. */
export function takeSlot(pool: LinePool): { device: string; user: string; project_path: string } | null {
  const slot = [...pool.slots].sort((a, b) => (b.runs - b.working) - (a.runs - a.working))[0];
  if (!slot || slot.runs - slot.working <= 0) return null;
  slot.working++;
  return { device: slot.device, user: slot.user, project_path: pool.subpath ? `${slot.root.replace(/\/+$/, "")}/${pool.subpath}` : slot.root };
}
