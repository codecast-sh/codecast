// What a push dropped and whose work it was: the names a deploy or dev push keeps (capNames), who put a name on a
// target (adderOf), and telling them (noticeDroppedWork, run by deploys.tellDroppedWork).

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { workspaceGrantsAccess } from "./access";
import { emitNotification } from "../notificationRouter";
import { targetDeploys, targetDevPushes } from "../deployTargetsState";

/** A deploy keeps at most this many names in `adds` and in `drops`, each cut to NAME_MAX characters. */
const NAMES_MAX = 500;
export const NAME_MAX = 200;
/** How far back through a target's deploys, and through its dev pushes, a name's adder is looked for. */
const ADDERS_SCAN = 200;
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

export type StartedBy = Doc<"deploys">["started_by"];

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

/** The names of `next` that `before` did not hold: what a write newly recorded. */
export const newNames = (next: ReadonlyArray<string>, before: ReadonlyArray<string> | undefined) => {
  const had = new Set(before ?? []);
  return next.filter((n) => !had.has(n));
};

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

/**
 * Tell people a push dropped their work in a transaction of its own, after the push's: a throw or a read limit there
 * never loses the push's record.
 */
export async function scheduleDroppedWork(ctx: any, d: Dropper, names: ReadonlyArray<string>, by: StartedBy): Promise<void> {
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

export const deployDropper = (d: Doc<"deploys">): Dropper => ({ workspace: d.workspace, target: d.target, repository: d.repository, machine: d.machine, deploy: d.short_id, exclude: String(d._id) });

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
