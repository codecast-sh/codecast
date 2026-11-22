import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { latestLiveDeploy, projectDeployViews, recordDeployMarker } from "./deploys";
import { deployLine } from "./deployTargetsState";
import { shapeView } from "./deploysView";

// Every push of a target is recorded with what it put on the target and took
// off it. A deploy.sh push is a deploy; a dev watcher's push is a dev push, in
// a table of its own, and never a deploy. Whoever's uncommitted push put a
// dropped name there hears about it. Synthetic data only.

const REPO = "acme/app";
const SHA = "aaaaaaa1111111";
const SHA2 = "bbbbbbb2222222";
const SHA3 = "ccccccc3333333";
const SHA4 = "ddddddd4444444";
const HOUR = 60 * 60 * 1000;
// Pushes minutes apart in life; a few milliseconds here so no two go live in the same one.
const pause = () => new Promise((r) => setTimeout(r, 5));

async function setup() {
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
  const mark = (who: keyof typeof tokens, over: Record<string, any> = {}) =>
    t.mutation(api.changesDeploy.markDeploy, { api_token: tokens[who], repository: REPO, surface: "backend", sha: SHA, team_id: ids.team, ...over });
  /** A deploy.sh push whose diff ran and read prod just now. */
  const ship = (who: keyof typeof tokens, over: Record<string, any> = {}) =>
    mark(who, { via: "deploy.sh", machine: `${who}-mac`, adds: [], drops: [], changes_read_at: Date.now(), ...over });
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
  return { t, ids, ws, tokens, mark, ship, save, deploys, devPushes, notes, events, addedBy, ageNotes, live };
}

async function withTarget() {
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

describe("a dev watcher's push is a dev push, never a deploy", () => {
  test("it writes a dev push and nothing else: no deploy, no event, no trigger, and a waiting line deploy stays waiting", async () => {
    const { t, ids, ws, save, ship, deploys, devPushes, events } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_tasks", { user_id: ids.ana, title: "After a deploy", prompt: "x", schedule_type: "event", status: "scheduled", run_count: 0, event_filter: { event_type: "deploy_live" }, created_at: 0, updated_at: 0 } as any);
      await ctx.db.insert("deploys", {
        short_id: "dp-900", workspace: ws, team_id: ids.team, target: "backend", status: "requested", trigger: "person",
        source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      });
    });
    const triggers = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f: any) => f.name.includes("matchTaskTriggers") && f.args[0]?.event_type === "deploy_live").length);

    const res = await save("ana", { dirty: 2, adds: ["fn:a:one"] });
    expect(res).toMatchObject({ ok: true, dev_push: true, deploy: null, event_id: null, surface: "backend", sha: SHA });
    expect(await deploys()).toEqual([expect.objectContaining({ short_id: "dp-900", status: "requested" })]);
    expect(await events()).toHaveLength(0);
    expect(await triggers()).toBe(0);
    expect(await devPushes()).toEqual([expect.objectContaining({
      workspace: ws, team_id: ids.team, repository: REPO, target: "backend", sha: SHA, machine: "ana-mac",
      started_by: expect.objectContaining({ name: "Ana", user_id: ids.ana }), dirty: 2, adds: ["fn:a:one"], drops: [],
    })]);

    // A deploy.sh push finishes the line's deploy, and fires the trigger.
    expect((await ship("ana", { sha: SHA2 })).deploy).toBe("dp-900");
    expect(await triggers()).toBe(1);
  });

  test("one row per pusher, machine and sha between deploys, holding the net change of its saves", async () => {
    const { save, devPushes } = await setup();
    await save("ana", { dirty: 2, adds: ["fn:a:one", "fn:a:tmp"], drops: ["fn:b:gone"] });
    await save("ana", { dirty: 3, adds: ["fn:a:two", "fn:b:gone"], drops: ["fn:a:tmp", "fn:b:other"] });
    let rows = await devPushes();
    expect(rows).toHaveLength(1);
    // fn:b:gone came back (off drops); fn:a:tmp the row itself added (off adds); fn:b:other is newly dropped.
    expect(rows[0]).toMatchObject({ dirty: 3, adds: ["fn:a:one", "fn:a:two"], drops: ["fn:b:other"] });
    expect(rows[0].live_at).toBeGreaterThanOrEqual(rows[0].created_at);

    // Another machine, another sha, another pusher on a hostname they share: a row each.
    await save("ana", { machine: "ana-mini" });
    await save("ana", { sha: SHA2 });
    await save("ben", { machine: "ana-mac" });
    rows = await devPushes();
    expect(rows).toHaveLength(4);
    // And each one's next save goes back to its own row.
    await save("ben", { machine: "ana-mac", adds: ["fn:b:x"] });
    await save("ana", { adds: ["fn:a:three"] });
    rows = await devPushes();
    expect(rows).toHaveLength(4);
    expect(rows[0].adds).toEqual(["fn:a:one", "fn:a:two", "fn:a:three"]);
    expect(rows[3]).toMatchObject({ started_by: expect.objectContaining({ name: "Ben" }), machine: "ana-mac", adds: ["fn:b:x"] });
  });

  test("a deploy after a dev push starts a new row on the next save", async () => {
    const { save, ship, devPushes, live } = await setup();
    await save("ana", { adds: ["fn:a:one"] });
    await pause();
    const shipped = await ship("ben", { sha: SHA2 });
    expect(await live()).toBe(shipped.deploy);
    await pause();
    await save("ana", { adds: ["fn:a:two"] });
    const rows = await devPushes();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.adds)).toEqual([["fn:a:one"], ["fn:a:two"]]);
  });

  test("a save that drops another's name and puts it back takes no credit for it, and a name it added then removed is no drop", async () => {
    const { save, ship, devPushes, notes, addedBy } = await setup();
    await save("ben", { sha: SHA2, adds: ["fn:b:z"] });
    await pause();
    await save("ana", { adds: ["fn:a:tmp"], drops: ["fn:b:z"] });
    await pause();
    await save("ana", { adds: ["fn:b:z"], drops: ["fn:a:tmp"] });
    expect((await devPushes()).find((p) => p.machine === "ana-mac")).toMatchObject({ adds: [], drops: [] });
    expect((await addedBy(["fn:b:z", "fn:a:tmp"])).map((f) => [f.name, f.by])).toEqual([["fn:b:z", "Ben"]]);
    const before = (await notes()).length;
    await pause();
    // Ben's own deploy later drops his uncommitted name: nobody is told, Ana least of all.
    await ship("ben", { sha: SHA3, drops: ["fn:b:z"] });
    expect(await notes()).toHaveLength(before);
  });

  test("a save that drops again what it put back is told again, past the quiet window", async () => {
    const { ids, save, devPushes, notes, ageNotes } = await setup();
    await save("ben", { sha: SHA2, adds: ["fn:b:z"] });
    await pause();
    await save("ana", { adds: ["fn:a:x"], drops: ["fn:b:z"] });
    expect(await notes()).toHaveLength(1);
    await save("ana", { adds: ["fn:b:z"], drops: ["fn:a:x"] });
    expect((await devPushes()).find((p) => p.machine === "ana-mac")).toMatchObject({ adds: [], drops: [] });
    await ageNotes(7 * HOUR);
    await save("ana", { drops: ["fn:b:z"] });
    expect((await devPushes()).find((p) => p.machine === "ana-mac")).toMatchObject({ adds: [], drops: ["fn:b:z"] });
    const told = await notes();
    expect(told).toHaveLength(2);
    expect(told.every((n) => String(n.recipient_user_id) === String(ids.ben))).toBe(true);
  });
});

describe("a deploy.sh push", () => {
  test("a dirty push lands on no live deploy of the same sha, clean or dirty: each is a deploy of its own", async () => {
    const { mark, deploys } = await setup();
    const clean = await mark("ana", { via: "deploy.sh", machine: "ana-mac" });
    await pause();
    const dirty = await mark("ana", { via: "deploy.sh", machine: "ana-mac", dirty: 84 });
    expect(dirty.deploy).not.toBe(clean.deploy);
    await pause();
    const dirtyAgain = await mark("ana", { via: "deploy.sh", machine: "ana-mac", dirty: 84, adds: ["fn:x:y"] });
    expect([clean.deploy, dirty.deploy]).not.toContain(dirtyAgain.deploy);
    const rows = await deploys();
    expect(rows).toHaveLength(3);
    expect(rows.find((d) => d.short_id === clean.deploy)!.dirty).toBeUndefined();
    expect(rows.find((d) => d.short_id === dirty.deploy)!.adds).toBeUndefined();
    expect(rows.find((d) => d.short_id === dirtyAgain.deploy)).toMatchObject({ dirty: 84, adds: ["fn:x:y"], pushed_via: "deploy.sh", machine: "ana-mac" });
  });

  test("adds and drops are capped at 500 names of 200 characters, tables, indexes and routes kept before functions", async () => {
    const { t, ids, ws, deploys } = await setup();
    const names = [...Array.from({ length: 600 }, (_, i) => `fn:m:f${String(i).padStart(3, "0")}`), "http:GET /z", "index:t.by_a", "table:t", `table:${"x".repeat(300)}`];
    await t.run(async (ctx) => {
      await recordDeployMarker(ctx, { workspace: ws, team_id: ids.team, target: "backend", sha: SHA, repository: REPO, source: "test", pushed_via: "deploy.sh", adds: names, drops: names, at: Date.now() });
    });
    const [row] = await deploys();
    expect(row.adds).toHaveLength(500);
    expect(row.drops).toHaveLength(500);
    expect(row.adds!.slice(0, 4)).toEqual(["table:t", `table:${"x".repeat(194)}`, "index:t.by_a", "http:GET /z"]);
    expect(row.adds![1]).toHaveLength(200);
    expect(row.adds![4]).toBe("fn:m:f000");
    expect(row.adds![499]).toBe("fn:m:f495");
    expect(row.drops!.slice(0, 4)).toEqual(row.adds!.slice(0, 4));
  });

  test("only a clean push that changed nothing lands on the clean live deploy of its sha; a dirty one still finishes the deploy it names", async () => {
    const { t, ids, ws, deploys } = await setup();
    const push = (over: Record<string, any>) => t.run(async (ctx) =>
      recordDeployMarker(ctx, { workspace: ws, team_id: ids.team, target: "backend", sha: SHA, repository: REPO, source: "test", pushed_via: "deploy.sh", at: Date.now(), ...over }));
    const first = await push({ adds: ["fn:a:one"], drops: [] });
    expect(await push({ adds: [], drops: [] })).toBe(first);
    expect(await push({})).toBe(first);
    const changed = await push({ adds: [], drops: ["fn:a:one"] });
    expect(changed).not.toBe(first);
    await t.run(async (ctx) => {
      await ctx.db.insert("deploys", {
        short_id: "dp-980", workspace: ws, team_id: ids.team, target: "backend", status: "requested", trigger: "person",
        source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      });
    });
    expect(await push({ deploy: "dp-980", dirty: 4, adds: ["fn:a:two"], drops: [] })).toBe("dp-980");
    expect((await deploys()).find((d) => d.short_id === "dp-980")).toMatchObject({ status: "live", dirty: 4, adds: ["fn:a:two"] });
  });

  test("a push that changed what runs is recorded even at the sha already live; a clean retry is not", async () => {
    const { mark, ship, deploys } = await setup();
    await ship("ana");
    await ship("ana");
    expect(await deploys()).toHaveLength(1);
    await pause();
    const again = await mark("ana", { via: "deploy.sh", drops: ["index:t.by_x"] });
    expect(again.deploy).toBeTruthy();
    expect(await deploys()).toHaveLength(2);
  });

  test("a clean push of the sha already live over someone's dev push put the committed tree back: a deploy of its own", async () => {
    const { ship, save, deploys, live } = await setup();
    const first = await ship("ana");
    await pause();
    await save("ben", { dirty: 3 });
    await pause();
    const back = await ship("ana");
    expect(back.deploy).toBeTruthy();
    expect(back.deploy).not.toBe(first.deploy);
    expect(await deploys()).toHaveLength(2);
    expect(await live()).toBe(back.deploy);
  });

  test("a clean redeploy of a sha after another deploy of it went live is a deploy of its own, and the target runs it", async () => {
    const { ship, deploys, live } = await setup();
    const one = await ship("ana", { sha: SHA2 });
    await pause();
    const dirty = await ship("ana", { sha: SHA2, dirty: 3 });
    await pause();
    const again = await ship("ana", { sha: SHA2 });
    expect([one.deploy, dirty.deploy]).not.toContain(again.deploy);
    expect(await live()).toBe(again.deploy);
    expect(await deploys()).toHaveLength(3);
  });

  test("a clean deploy.sh of the last marked sha after a workflow run rolled the target back is recorded, and runs", async () => {
    const { t, ids, ws, ship, deploys, live } = await setup();
    const first = await ship("ana");
    await pause();
    const rollback = await t.run(async (ctx) =>
      recordDeployMarker(ctx, { workspace: ws, team_id: ids.team, target: "backend", sha: SHA2, repository: REPO, source: "github", workflow_run: "777", status: "live", at: Date.now() }));
    expect(rollback).not.toBe(first.deploy);
    await pause();
    const again = await ship("ana");
    expect([first.deploy, rollback]).not.toContain(again.deploy);
    expect(await deploys()).toHaveLength(3);
    expect(await live()).toBe(again.deploy);
  });

  test("a status re-sent for an earlier deploy's sha lands on that deploy, and fires no trigger again", async () => {
    const { t, ids, ws, deploys } = await setup();
    const base = Date.now() - 100_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_tasks", { user_id: ids.ana, title: "After a deploy", prompt: "x", schedule_type: "event", status: "scheduled", run_count: 0, event_filter: { event_type: "deploy_live" }, created_at: 0, updated_at: 0 } as any);
    });
    const matches = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f: any) => f.name.includes("matchTaskTriggers") && f.args[0]?.event_type === "deploy_live").length);
    const gh = (sha: string, at: number) => t.run(async (ctx) =>
      recordDeployMarker(ctx, { workspace: ws, team_id: ids.team, target: "web", sha, repository: REPO, source: "github: railway", status: "live", at }));
    const a = await gh(SHA, base);
    const b = await gh(SHA2, base + 10_000);
    expect(await matches()).toBe(2);
    expect(await gh(SHA, base + 1_000)).toBe(a);
    expect(await deploys()).toHaveLength(2);
    expect(await matches()).toBe(2);
    expect((await t.run(async (ctx) => latestLiveDeploy(ctx, ws, "web", REPO)))?.short_id).toBe(b);
  });

  test("markDeploy and a ship pass's deploy step store when the push's diff read prod", async () => {
    const { t, ids, tokens, ship, deploys } = await setup();
    const marked = await ship("ana", { changes_read_at: 1234 });
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, ok: true, stage: "done", pushed: SHA2, commits: [], held: [], started_at: Date.now() - 1000,
      deploys: [{ name: "convex", stage: "deploy", ok: true, target: "backend", machine: "ana-mac", via: "deploy.sh", adds: ["fn:a:new"], drops: [], changes_read_at: 5678 }],
    });
    const rows = await deploys();
    expect(rows.find((d) => d.short_id === marked.deploy)).toMatchObject({ changes_read_at: 1234 });
    expect(rows.find((d) => d.short_id === pass.deploys[0].deploy)).toMatchObject({ changes_read_at: 5678, machine: "ana-mac", pushed_via: "deploy.sh", adds: ["fn:a:new"], drops: [] });
  });
});

describe("who added a name", () => {
  test("each name answers with the push active last that added it, a deploy or a dev push; names never added are left out", async () => {
    const { save, ship, addedBy } = await setup();
    await save("ben", { dirty: 2, adds: ["table:voiceprints", "index:voiceprints.by_user"] });
    await pause();
    // Dirty, so it proves nothing committed.
    const two = await ship("ana", { sha: SHA2, dirty: 1, adds: ["index:voiceprints.by_user"] });
    const found = await addedBy(["table:voiceprints", "index:voiceprints.by_user", "fn:never:added"]);
    expect(found).toHaveLength(2);
    const dev = found.find((f) => f.name === "table:voiceprints")!;
    expect(dev).toEqual({ name: "table:voiceprints", deploy: null, dev_push: true, by: "Ben", machine: "ben-mac", via: "dev watcher", at: expect.any(Number), dirty: 2 });
    expect(found.find((f) => f.name === "index:voiceprints.by_user")).toEqual({
      name: "index:voiceprints.by_user", deploy: two.deploy, dev_push: false, by: "Ana", machine: "ana-mac", via: "deploy.sh", at: expect.any(Number), dirty: 1,
    });
  });

  test("a later clean deploy whose diff read prod after the add, and kept the name, is where it was committed", async () => {
    const { save, ship, notes, addedBy } = await setup();
    await save("ben", { dirty: 2, adds: ["table:voiceprints"] });
    await pause();
    const kept = await ship("ana", { sha: SHA2 });
    expect((await addedBy(["table:voiceprints"]))[0]).toMatchObject({ dev_push: true, by: "Ben", committed_in: kept.deploy });
    // Months later Ana removes it on purpose, in a commit: nobody is told.
    await pause();
    await ship("ana", { sha: SHA3, drops: ["table:voiceprints"] });
    expect(await notes()).toHaveLength(0);
  });

  test("a clean deploy whose diff read prod before the adder's last push proves nothing: the work is still uncommitted", async () => {
    const { ids, save, ship, notes, addedBy } = await setup();
    // Ben's deploy.sh reads prod at t=1, then sits in its typecheck.
    const t1 = Date.now();
    await pause();
    // Ana's dev push adds a table at t=5.
    await save("ana", { adds: ["table:anas"] });
    await pause();
    // Ben's clean push goes out at t=10, its diff (read at t=1) dropped nothing.
    const bens = await ship("ben", { sha: SHA2, changes_read_at: t1 });
    expect(bens.deploy).toBeTruthy();
    expect((await addedBy(["table:anas"]))[0].committed_in).toBeUndefined();
    // So when Ben's next deploy drops it, Ana is told.
    await pause();
    const drop = await ship("ben", { sha: SHA3, drops: ["table:anas"] });
    expect(await notes()).toEqual([expect.objectContaining({ recipient_user_id: ids.ana, actor_user_id: ids.ben, entity_id: drop.deploy })]);
  });

  test("a later dirty push of the adder counts from its last save, not its first", async () => {
    const { save, ship, addedBy } = await setup();
    await save("ana", { adds: ["table:anas"] });
    await pause();
    // A diff read between Ana's saves: her row's last save comes after it.
    const read = Date.now();
    await pause();
    await save("ana", { adds: ["fn:a:more"] });
    await pause();
    await ship("ben", { sha: SHA2, changes_read_at: read });
    expect((await addedBy(["table:anas"]))[0].committed_in).toBeUndefined();
  });

  test("a clean deploy whose diff did not run is no proof a name was committed", async () => {
    const { ids, mark, save, ship, notes, addedBy } = await setup();
    await save("ben", { dirty: 2, adds: ["table:voiceprints"] });
    await pause();
    // An older cast, or a prod the diff could not read: no names, no read time.
    const blind = await mark("ana", { via: "deploy.sh", sha: SHA2 });
    expect((await addedBy(["table:voiceprints"]))[0].committed_in).toBeUndefined();
    await pause();
    const drop = await ship("ana", { sha: SHA3, drops: ["table:voiceprints"] });
    expect(await notes()).toEqual([expect.objectContaining({ recipient_user_id: ids.ben, entity_id: drop.deploy })]);
    expect(blind.deploy).toBeTruthy();
  });

  test("a clean deploy after the name was dropped is no proof it was committed", async () => {
    const { save, ship, addedBy } = await setup();
    await save("ben", { dirty: 2, adds: ["table:voiceprints"] });
    await pause();
    await save("ana", { sha: SHA2, drops: ["table:voiceprints"] });
    await pause();
    await ship("ana", { sha: SHA3 });
    expect((await addedBy(["table:voiceprints"]))[0].committed_in).toBeUndefined();
  });

  test("a drop older than the name's last add does not hide the clean deploy that kept it", async () => {
    const { save, ship, notes, ageNotes } = await setup();
    await save("ana", { adds: ["fn:a:n"] });
    await pause();
    await save("ben", { sha: SHA2, drops: ["fn:a:n"] });
    await pause();
    // Ana's watcher puts it back on its own row; she commits it, and the next clean deploy keeps it.
    await save("ana", { adds: ["fn:a:n"] });
    await pause();
    await ship("ben", { sha: SHA3 });
    expect(await notes()).toHaveLength(1);
    await ageNotes(7 * 24 * HOUR);
    await pause();
    await ship("ben", { sha: SHA4, drops: ["fn:a:n"] });
    expect(await notes()).toHaveLength(1);
  });
});

describe("telling people their dropped work", () => {
  test("a deploy's drop of a dev push's work links to the deploy; clean commits and the pusher's own work are not told", async () => {
    const { ids, save, ship, notes } = await setup();
    // A clean commit of Ben's added a function; then his watcher put an index and a table up from his working tree.
    await ship("ben", { sha: SHA2, adds: ["fn:clean:commit"] });
    await pause();
    await save("ben", { dirty: 2, adds: ["index:voiceprints.by_user", "table:voiceprints"] });
    await pause();
    // Ana's own dirty push added something too.
    await ship("ana", { sha: SHA3, dirty: 1, adds: ["fn:ana:own"] });
    await pause();
    const drops = ["index:voiceprints.by_user", "table:voiceprints", "fn:clean:commit", "fn:ana:own"];
    const anas = await ship("ana", { sha: SHA4, drops });
    expect(await notes()).toEqual([expect.objectContaining({
      recipient_user_id: ids.ben,
      type: "deploy_dropped_work",
      actor_user_id: ids.ana,
      entity_type: "deploy",
      entity_id: anas.deploy,
      link: `/deploys?deploy=${anas.deploy}`,
      message: `${anas.deploy} dropped 2 things your dev push put on backend: index:voiceprints.by_user, table:voiceprints`,
    })]);
  });

  test("a dev push's drop of a dirty deploy's work links to the Deploys page and names the deploy it ran on", async () => {
    const { ids, save, ship, notes } = await setup();
    const bens = await ship("ben", { sha: SHA2, dirty: 3, adds: ["fn:b:dirty"] });
    await pause();
    await save("ana", { drops: ["fn:b:dirty"] });
    expect(await notes()).toEqual([expect.objectContaining({
      recipient_user_id: ids.ben,
      actor_user_id: ids.ana,
      entity_type: "deploy",
      entity_id: bens.deploy,
      link: "/deploys",
      message: `Ana's dev push from ana-mac dropped 1 thing your uncommitted push ${bens.deploy} put on backend: fn:b:dirty`,
    })]);
  });

  test("the words name dev pushes and uncommitted deploys together, and a long list names five and counts the rest", async () => {
    const { ids, save, ship, notes } = await setup();
    const names = Array.from({ length: 8 }, (_, i) => `fn:b:f${i}`);
    const dirty = await ship("ben", { sha: SHA2, dirty: 3, adds: names.slice(0, 4) });
    await pause();
    await save("ben", { adds: names.slice(4) });
    await pause();
    const drop = await ship("ana", { sha: SHA3, drops: names });
    const [row] = await notes();
    expect(row).toMatchObject({ recipient_user_id: ids.ben });
    expect(row.message).toBe(`${drop.deploy} dropped 8 things your dev push and uncommitted push ${dirty.deploy} put on backend: fn:b:f0, fn:b:f1, fn:b:f2, fn:b:f3, fn:b:f4 and 3 more`);
  });

  test("two watchers dropping each other's work on every save tell each person once per six hours per dropper", async () => {
    const { ids, save, devPushes, notes, ageNotes } = await setup();
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) await save("ana", { adds: ["fn:a:x"], drops: i ? ["fn:b:y"] : [] });
      else await save("ben", { sha: SHA2, adds: ["fn:b:y"], drops: ["fn:a:x"] });
      await pause();
    }
    expect(await devPushes()).toHaveLength(2);
    let rows = await notes();
    expect(rows.map((r) => String(r.recipient_user_id)).sort()).toEqual([String(ids.ana), String(ids.ben)].sort());
    // Past the quiet window, the next drop is told again.
    await ageNotes(7 * HOUR);
    await save("ana", { adds: ["fn:a:x"], drops: ["fn:b:y"] });
    rows = await notes();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ recipient_user_id: ids.ben, actor_user_id: ids.ana, link: "/deploys" });
  });

  test("a different pusher's drop inside the quiet window still tells the adder; the same pusher's does not", async () => {
    const { ids, save, ship, notes } = await setup();
    await save("ana", { adds: ["table:one"] });
    await pause();
    await ship("ben", { sha: SHA2, drops: ["table:one"] });
    await pause();
    await save("ana", { sha: SHA2, adds: ["table:two"] });
    await pause();
    const cys = await ship("cy", { sha: SHA3, drops: ["table:two"] });
    await pause();
    await save("ana", { sha: SHA3, adds: ["table:three"] });
    await pause();
    await ship("ben", { sha: SHA4, drops: ["table:three"] });
    const rows = await notes();
    expect(rows.map((r) => [String(r.recipient_user_id), String(r.actor_user_id)])).toEqual([[String(ids.ana), String(ids.ben)], [String(ids.ana), String(ids.cy)]]);
    expect(rows[1]).toMatchObject({ entity_id: cys.deploy, actor_name: "Cy" });
  });

  test("a push finishing a deploy a role asked for names the pusher as the dropper, and never tells them of their own", async () => {
    const { t, ids, ws, save, ship, notes } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deploys", {
        short_id: "dp-950", workspace: ws, team_id: ids.team, target: "backend", status: "requested", trigger: "role",
        started_by: { kind: "role", name: "release" }, source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      });
    });
    await save("ben", { adds: ["table:bar"] });
    await save("ana", { sha: SHA2, adds: ["table:foo"] });
    await pause();
    const finished = await ship("ana", { sha: SHA3, drops: ["table:foo", "table:bar"] });
    expect(finished.deploy).toBe("dp-950");
    expect(await notes()).toEqual([expect.objectContaining({
      recipient_user_id: ids.ben, actor_user_id: ids.ana, actor_name: "Ana", entity_id: "dp-950",
      message: "dp-950 dropped 1 thing your dev push put on backend: table:bar",
    })]);
  });

  test("a ship pass's deploy step's drops tell the adder", async () => {
    const { t, ids, tokens, save, notes } = await setup();
    await save("ben", { adds: ["table:voiceprints"] });
    await pause();
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, ok: true, stage: "done", pushed: SHA2, commits: [], held: [], started_at: Date.now() - 1000,
      deploys: [{ name: "convex", stage: "deploy", ok: true, target: "backend", machine: "ana-mac", via: "deploy.sh", adds: ["fn:a:new"], drops: ["table:voiceprints"], changes_read_at: Date.now() }],
    });
    expect(await notes()).toEqual([expect.objectContaining({ recipient_user_id: ids.ben, entity_id: pass.deploys[0].deploy })]);
  });

  test("two people's uncommitted pushes of one HEAD are two deploys, and the second's drop of the first's work is told", async () => {
    const { ids, ship, deploys, notes } = await setup();
    const anas = await ship("ana", { dirty: 2, adds: ["table:anas"] });
    await pause();
    const bens = await ship("ben", { dirty: 5, adds: ["fn:ben:x"], drops: ["table:anas"] });
    expect(bens.deploy).not.toBe(anas.deploy);
    expect(await deploys()).toHaveLength(2);
    expect(await notes()).toEqual([expect.objectContaining({ recipient_user_id: ids.ana, actor_user_id: ids.ben, entity_id: bens.deploy })]);
  });

  test("someone who left the team is not told a push dropped their work", async () => {
    const { t, ids, save, ship, notes } = await setup();
    await save("ben", { sha: SHA2, adds: ["table:bens"] });
    await t.run(async (ctx) => {
      const m = await ctx.db.query("team_memberships").filter((q) => q.eq(q.field("user_id"), ids.ben)).first();
      await ctx.db.delete(m!._id);
    });
    await pause();
    await ship("ana", { drops: ["table:bens"] });
    await save("ana", { sha: SHA3, drops: ["table:bens"] });
    expect(await notes()).toHaveLength(0);
  });
});

describe("what readers see", () => {
  test("a targets-view row counts the names; the deploy's own view lists them", async () => {
    const { t, ship, deploys } = await setup();
    await ship("ana", { adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
    const [row] = await deploys();
    const { line, view } = await t.run(async (ctx) => ({
      line: await deployLine(ctx, row, { conv: new Map(), task: new Map() }),
      view: await shapeView(ctx, row),
    }));
    expect(line).toMatchObject({ machine: "ana-mac", pushed_via: "deploy.sh", dirty: null, adds_count: 2, drops_count: 1 });
    expect("adds" in line).toBe(false);
    expect(view).toMatchObject({ adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
  });

  test("the line's deploy rows count the names; the deploy's own read lists them", async () => {
    const { t, ids, ws, tokens, ship } = await setup();
    const pushed = await ship("ana", { adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
    const rows = await t.run(async (ctx) => projectDeployViews(ctx, { _id: "p", workspace: ws } as any, [REPO], 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ short_id: pushed.deploy, adds_count: 2, drops_count: 1, machine: "ana-mac", pushed_via: "deploy.sh" });
    expect("adds" in rows[0]).toBe(false);
    expect(await t.query(api.deploys.get, { api_token: tokens.ana, ref: pushed.deploy! })).toMatchObject({ adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
    void ids;
  });

  test("both feeders of the Deploys page's rows send what each push was, the same for the same row", async () => {
    const { t, ids, ship, view } = await withTarget();
    await ship("ana", { adds: ["fn:a:one"] });
    await pause();
    await ship("ben", { sha: SHA2, dirty: 3, adds: ["fn:b:two"], drops: ["table:gone", "fn:a:one"] });
    const fromView = (await view()).history;
    const fromList = await t.withIdentity({ subject: `${ids.ana}|test` }).query(api.deployRefs.recentForTeam, { team_id: ids.team });
    const fields = (d: any) => ({ _id: d._id, pushed_via: d.pushed_via, machine: d.machine, dirty: d.dirty, adds_count: d.adds_count, drops_count: d.drops_count });
    expect(fromView).toHaveLength(2);
    expect(fromList.map(fields)).toEqual(fromView.map(fields));
    expect(fields(fromList[0])).toMatchObject({ pushed_via: "deploy.sh", machine: "ben-mac", dirty: 3, adds_count: 1, drops_count: 2 });
  });

  test("the targets view shows the dev push prod runs on top of the live deploy, until a deploy puts the committed tree back", async () => {
    const { ship, save, view } = await withTarget();
    expect((await view()).dev_push).toBeNull();
    const one = await ship("ana");
    await pause();
    expect((await view()).dev_push).toBeNull();
    await save("ben", { sha: SHA2, dirty: 4, adds: ["fn:b:x", "fn:b:y"], drops: ["table:t"] });
    await pause();
    await save("cy", { sha: SHA2, dirty: 2, adds: ["fn:c:z"] });
    const shown = await view();
    expect(shown.live).toMatchObject({ short_id: one.deploy });
    expect(shown.dev_push).toEqual({ sha: SHA2, machine: "cy-mac", by: "Cy", at: expect.any(Number), dirty: 2, adds_count: 1, drops_count: 0 });
    await pause();
    const two = await ship("ana", { sha: SHA3 });
    const after = await view();
    expect(after.live).toMatchObject({ short_id: two.deploy });
    expect(after.dev_push).toBeNull();
  });

  test("a pile of dev pushes after a deploy never hides it: it is live, already live, the way back, and the history is deploys only", async () => {
    const { t, ids, ship, save, view, request, deploys } = await withTarget();
    const sha = (n: number) => String(n % 10).repeat(30) + String(n).padStart(10, "0");
    const base = Date.now() - 1_000_000;
    await t.run(async (ctx) => {
      for (const n of [1, 2, 3]) {
        await ctx.db.insert("commits", {
          sha: sha(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: base, files_changed: 1, insertions: 1, deletions: 0,
          repository: REPO, team_id: ids.team, branch: "main", main_at: base + n,
          files: [{ filename: `convex/f${n}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 }],
        });
      }
    });
    await ship("ana", { sha: sha(1) });
    await pause();
    const two = await ship("ana", { sha: sha(2) });
    await pause();
    // More dev pushes than any window reads: 110 shas, three machines, two people.
    for (let i = 0; i < 110; i++) await save(i % 2 ? "ana" : "ben", { sha: sha(100 + i), machine: `m${i % 3}` });
    expect(await deploys()).toHaveLength(2);

    const now = await view();
    expect(now.live).toMatchObject({ short_id: two.deploy, sha: sha(2) });
    expect(now.history.map((d: any) => d.short_id)).toEqual([two.deploy, expect.stringMatching(/^dp-/)]);
    expect(now.dev_push).toMatchObject({ sha: sha(209) });
    expect(now.queue.commits).toBe(1);
    // `cast deploy --sha` of the live deploy's sha is refused as already live.
    await expect(request({ sha: sha(2) })).rejects.toThrow("is already live on backend");
    const reach = await t.withIdentity({ subject: `${ids.ana}|test` }).query(api.deployReach.get, { ref: `${REPO}@${sha(2)}` });
    expect(reach!.targets[0]).toMatchObject({ state: "live", deploy: { short_id: two.deploy } });
    // A rollback goes back to the deploy before it.
    expect(await request({ action: "rollback" })).toMatchObject({ action: "rollback", sha: sha(1) });
  });
});
