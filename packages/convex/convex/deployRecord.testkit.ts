import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { latestLiveDeploy } from "./lib/deployRows";

// The shared fixture of deploys.record.test.ts, devPushes.test.ts and droppedWork.test.ts. Synthetic data only.

export const REPO = "acme/app";
export const SHA = "aaaaaaa1111111";
export const SHA2 = "bbbbbbb2222222";
export const SHA3 = "ccccccc3333333";
export const SHA4 = "ddddddd4444444";
export const HOUR = 60 * 60 * 1000;
// Pushes minutes apart in life; a few milliseconds here so no two go live in the same one.
export const pause = () => new Promise((r) => setTimeout(r, 5));

export async function setup() {
  const t = convexTest(schema, allModules);
  const tokens = { ana: "deploy-record-ana", ben: "deploy-record-ben", cy: "deploy-record-cy" };
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" });
    const ben = await ctx.db.insert("users", { name: "Ben" });
    const cy = await ctx.db.insert("users", { name: "Cy" });
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    for (const [user, token] of [[ana, tokens.ana], [ben, tokens.ben], [cy, tokens.cy]] as const) {
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: 1 } as any);
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "Test", created_at: 1, last_used_at: 1 });
    }
    return { ana, ben, cy, team };
  });
  const ws = `team:${ids.team}`;
  /** Lets what a write scheduled (telling people their dropped work) run, and waits for it. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  };
  const mark = async (who: keyof typeof tokens, over: Record<string, any> = {}) => {
    const res = await t.mutation(api.changesDeploy.markDeploy, { api_token: tokens[who], repository: REPO, surface: "backend", sha: SHA, team_id: ids.team, ...over });
    await settle();
    return res;
  };
  /** A deploy.sh push whose diff ran and read prod just now. */
  const ship = (who: keyof typeof tokens, over: Record<string, any> = {}) =>
    mark(who, { via: "deploy.sh", machine: `${who}-mac`, adds: [], drops: [], changes_read_age_ms: 0, ...over });
  /** A dev watcher's save. */
  const save = (who: keyof typeof tokens, over: Record<string, any> = {}) =>
    mark(who, { via: "dev watcher", machine: `${who}-mac`, dirty: 1, adds: [], drops: [], ...over });
  const deploys = () => t.run(async (ctx) => (await ctx.db.query("deploys").collect()).sort((a, b) => a.created_at - b.created_at || a._creationTime - b._creationTime));
  const devPushes = () => t.run(async (ctx) => (await ctx.db.query("dev_pushes").collect()).sort((a, b) => a._creationTime - b._creationTime));
  const notes = () => t.run(async (ctx) => (await ctx.db.query("notifications").collect()).sort((a, b) => a._creationTime - b._creationTime));
  const events = () => t.run(async (ctx) => (await ctx.db.query("external_events").collect()).filter((e) => e.kind === "deploy"));
  const addedBy = (names: string[], who: keyof typeof tokens = "ana") =>
    t.query(api.changesDeploy.addedBy, { api_token: tokens[who], repository: REPO, surface: "backend", team_id: ids.team, names }).then((r) => r.found);
  const ageNotes = (ms: number) => t.run(async (ctx) => {
    for (const n of await ctx.db.query("notifications").collect()) await ctx.db.patch(n._id, { created_at: n.created_at - ms });
  });
  const live = () => t.run(async (ctx) => (await latestLiveDeploy(ctx, ws, "backend", REPO))?.short_id);
  return { t, ids, ws, tokens, settle, mark, ship, save, deploys, devPushes, notes, events, addedBy, ageNotes, live };
}


/** A 40-character sha for commit n. */
export const shaN = (n: number) => String(n % 10).repeat(30) + String(n).padStart(10, "0");

/** Commits on the repository's default branch, so a deploy can name them. */
export async function onMain(t: Awaited<ReturnType<typeof setup>>["t"], team: any, ns: number[]) {
  const base = Date.now() - 1_000_000;
  await t.run(async (ctx) => {
    for (const n of ns) {
      await ctx.db.insert("commits", {
        sha: shaN(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: base, files_changed: 1, insertions: 1, deletions: 0,
        repository: REPO, team_id: team, branch: "main", main_at: base + n,
        files: [{ filename: `convex/f${n}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 }],
      });
    }
  });
}

export async function withTarget() {
  const s = await setup();
  await s.t.mutation(api.deployTargets.publish, {
    api_token: s.tokens.ana, team_id: s.ids.team, repository: REPO, root: "/repo",
    targets: [{ name: "backend", command: "./deploy.sh $sha", rollback: "./rollback.sh $sha", runs: "here", live: { kind: "marker" }, policy: "press", paths: ["convex/**"] }],
  });
  const view = async () => (await s.t.query(api.deployTargets.view, { api_token: s.tokens.ana, team_id: s.ids.team, target: "backend" })).targets[0];
  const request = (over: Record<string, any> = {}) =>
    s.t.mutation(api.deployTargets.request, { api_token: s.tokens.ana, team_id: s.ids.team, target: "backend", here: true, ...over });
  return { ...s, view, request };
}
