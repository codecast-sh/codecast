// Where a line run works (the-line-end-to-end.md LE6): the runner's machines
// that offer a checkout of the role's repository (devices.line_slots), each
// with its own number of runs at once. The role's folder names the checkout
// on the machine it was seated from; its origin, read from that machine's git
// plane, names the repository, and the subpath under the repository root
// names the same folder on every machine in the pool.
import { normalizeGitOrigin, pathUnderRoot } from "@codecast/shared/contracts";
import { isDeviceOnline } from "../ccAccountsShared";

type Ctx = { db: any };

export type LineSlot = { device: string; root: string; runs: number; working: number };
export type LinePool = { origin: string; subpath: string; slots: LineSlot[] };

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
 * card, and the runner does not kill it at the node's timeout.
 */
export async function holdsSlot(ctx: Ctx, run: any, waiting: Set<string>): Promise<boolean> {
  if (!(run.org_role_id || run.task_id) || waiting.has(String(run._id))) return false;
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  return !task?.waiting_since;
}

/** The runs a device's line slot takes at once: none while an operator holds the device (linePool.holdLine). */
export const slotRuns = (device: { line_hold?: unknown }, slot: { runs: number }): number => (device.line_hold ? 0 : slot.runs);

/** The runner's devices that offer any line checkout: their runs are counted by the pool, not the runner's own cap. */
export async function poolDeviceIds(ctx: Ctx, runner: string): Promise<Set<string>> {
  const devices: any[] = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", runner)).collect();
  return new Set(devices.filter((d) => d.line_slots?.length).map((d) => String(d.device_id)));
}

/** The pool for a role whose folder is `projectPath`, or null when no online machine of the runner offers its repository. */
export async function linePoolFor(ctx: Ctx, runner: string, projectPath: string | undefined, now: number): Promise<LinePool | null> {
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
  const waiting = await runsWaitingOnAPerson(ctx, runner);
  const slots: LineSlot[] = [];
  for (const d of devices) {
    if (!isDeviceOnline(d, now)) continue;
    // A slot with no runs (a spent account, a full disk, an operator's hold) keeps its machine in the pool with no room,
    // so the run waits for a slot instead of falling back to the runner's own machine (Oct 24: 7 of 10 runs landed on
    // the laptop).
    const slot = (d.line_slots ?? []).find((s: any) => s.origin === origin);
    if (!slot) continue;
    let working = 0;
    for (const status of WORKING_RUN_STATUSES) {
      const runs: any[] = await ctx.db
        .query("workflow_runs")
        .withIndex("by_runner_device_status", (q: any) => q.eq("runner_device", String(d.device_id)).eq("status", status))
        .collect();
      for (const r of runs) if (await holdsSlot(ctx, r, waiting)) working++;
    }
    slots.push({ device: String(d.device_id), root: slot.root, runs: slotRuns(d, slot), working });
  }
  return slots.length ? { origin, subpath, slots } : null;
}

export const poolFree = (pool: LinePool): number => pool.slots.reduce((n, s) => n + Math.max(0, s.runs - s.working), 0);
export const poolCap = (pool: LinePool): number => pool.slots.reduce((n, s) => n + s.runs, 0);
export const poolWorking = (pool: LinePool): number => pool.slots.reduce((n, s) => n + s.working, 0);

/** The slot with the most free runs, and the run's folder there; null when every slot is full. Counts the run on it. */
export function takeSlot(pool: LinePool): { device: string; project_path: string } | null {
  const slot = [...pool.slots].sort((a, b) => (b.runs - b.working) - (a.runs - a.working))[0];
  if (!slot || slot.runs - slot.working <= 0) return null;
  slot.working++;
  return { device: slot.device, project_path: pool.subpath ? `${slot.root.replace(/\/+$/, "")}/${pool.subpath}` : slot.root };
}
