import { describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { projectDeployViews, recordDeployMarker } from "./deploys";
import { latestLiveDeploy } from "./lib/deployRows";
import { deployLine } from "./deployTargetsState";
import { shapeView } from "./deploysView";
import { HOUR, onMain, pause, REPO, setup, SHA, SHA2, SHA3, shaN, withTarget } from "./deployRecord.testkit";

// Every push of a target is recorded with what it put on the target and took
// off it. A deploy.sh push is a deploy; a dev watcher's push is a dev push, in
// a table of its own, and never a deploy. Whoever's uncommitted push put a
// dropped name there hears about it. Synthetic data only.

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
      recordDeployMarker(ctx, { workspace: ws, team_id: ids.team, target: "backend", sha: SHA, repository: REPO, source: "test", pushed_via: "deploy.sh", push: true, at: Date.now(), ...over }));
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

  test("an uncommitted push never finishes a deploy someone else asked for; its work stays its pusher's", async () => {
    const { t, ids, ws, ship, deploys, notes, addedBy } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deploys", {
        short_id: "dp-960", workspace: ws, team_id: ids.team, target: "backend", status: "requested", trigger: "person",
        started_by: { kind: "person", name: "Ben", user_id: ids.ben }, repository: REPO,
        source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      } as any);
    });
    // Ana pushes her branch with uncommitted files while Ben's deploy waits.
    const anas = await ship("ana", { sha: shaN(2), dirty: 3, adds: ["table:ana_new"] });
    expect(anas.deploy).not.toBe("dp-960");
    // Ben's deploy never took Ana's work: it is superseded by her live push, as by any newer deploy, never finished by it.
    const bens = (await deploys()).find((d) => d.short_id === "dp-960")!;
    expect(bens.status).not.toBe("live");
    expect(bens.adds).toBeUndefined();
    // A clean push of main drops Ana's table: Ana is told, not Ben.
    await ship("cy", { sha: shaN(3), drops: ["table:ana_new"] });
    expect((await notes()).map((n) => n.recipient_user_id)).toEqual([ids.ana]);
    expect((await addedBy(["table:ana_new"]))[0]).toMatchObject({ deploy: anas.deploy, by: "Ana" });
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

  test("a report of a deploy already made lands on the live deploy of its sha, clean or dirty", async () => {
    const { t, ids, ws, ship, deploys, live } = await withTarget();
    const dirty = await ship("ana", { dirty: 3 });
    await pause();
    for (const source of ["live reader", "github: railway"]) {
      const landed = await t.run(async (ctx) =>
        recordDeployMarker(ctx, { workspace: ws, team_id: ids.team, target: "backend", sha: SHA, repository: REPO, source, status: "live", at: Date.now() }));
      expect(landed).toBe(dirty.deploy);
    }
    expect(await t.mutation(internal.deployTargets.recordPastDeploy, { repository: REPO, target: "backend", sha: SHA, at: Date.now() - HOUR, source: "release history" })).toBe(dirty.deploy);
    expect(await deploys()).toHaveLength(1);
    expect(await live()).toBe(dirty.deploy);
  });

  test("a backfilled codecast marker of a sha live earlier is a report, not a fresh push: it lands on that deploy and fires nothing", async () => {
    const { t, ids, ship, deploys, live } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_tasks", { user_id: ids.ana, title: "After a deploy", prompt: "x", schedule_type: "event", status: "scheduled", run_count: 0, event_filter: { event_type: "deploy_live" }, created_at: 0, updated_at: 0 } as any);
    });
    const triggers = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f: any) => f.name.includes("matchTaskTriggers") && f.args[0]?.event_type === "deploy_live").length);
    const one = await ship("ana");
    await pause();
    const two = await ship("ana", { sha: SHA2 });
    expect(await triggers()).toBe(2);
    // A marker event of SHA that no deploy holds yet (one recorded before deploys were).
    await t.run(async (ctx) => {
      await ctx.db.insert("external_events", { source: "codecast", team_id: ids.team, repository: REPO, kind: "deploy", actor_user_id: ids.ana, title: "backend at aaaaaaa", sha: SHA, meta: { surface: "backend" }, dedupe_key: "old", created_at: Date.now() } as any);
    });
    expect(await t.mutation(internal.deploysBackfill.backfill, { repository: REPO })).toMatchObject({ recorded: 1 });
    expect((await deploys()).map((d) => d.short_id)).toEqual([one.deploy, two.deploy]);
    expect(await live()).toBe(two.deploy);
    expect(await triggers()).toBe(2);
  });

  test("a ship pass's deploy went live when its step pushed: a dev push saved before the pass ended runs on top of it", async () => {
    const { t, ids, tokens, settle, save, view, deploys, addedBy } = await withTarget();
    // The step pushed 10s ago. The server dates the push as its own now minus the age sent, so live_at lands
    // at pushed plus the mutation's latency; the 10s keeps that latency far from Ben's later save.
    const pushed = Date.now() - 10_000;
    await pause();
    await save("ben", { sha: SHA2, dirty: 2, adds: ["fn:b:x"] });
    await pause();
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, ok: true, stage: "done", pushed: SHA2, commits: [], held: [], started_at: pushed - 60_000,
      deploys: [{ name: "convex", stage: "deploy", ok: true, target: "backend", machine: "ana-mac", via: "deploy.sh", adds: [], drops: [], changes_read_age_ms: Date.now() - pushed + 30_000, pushed_age_ms: Date.now() - pushed }],
    });
    await settle();
    const [row] = await deploys();
    expect(row.short_id).toBe(pass.deploys[0].deploy);
    expect(row.live_at).toBeGreaterThanOrEqual(pushed);
    expect(row.live_at).toBeLessThan(pushed + 5_000);
    const shown = await view();
    expect(shown.live).toMatchObject({ short_id: row.short_id });
    expect(shown.dev_push).toMatchObject({ by: "Ben", adds_count: 1 });
    // The deploy's diff read prod before Ben's save, so it proves nothing of his name.
    expect((await addedBy(["fn:b:x"]))[0]).toMatchObject({ dev_push: true, by: "Ben" });
    expect((await addedBy(["fn:b:x"]))[0].committed_in).toBeUndefined();
  });

  test("markDeploy and a ship pass's deploy step store when the push's diff read prod, by the server's clock", async () => {
    const { t, ids, tokens, ship, deploys } = await setup();
    // The pusher says how long ago its diff read prod; its own clock may be hours off the server's.
    const before = Date.now();
    const marked = await ship("ana", { changes_read_age_ms: 60_000 });
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, ok: true, stage: "done", pushed: SHA2, commits: [], held: [], started_at: Date.now() - 1000,
      deploys: [{ name: "convex", stage: "deploy", ok: true, target: "backend", machine: "ana-mac", via: "deploy.sh", adds: ["fn:a:new"], drops: [], changes_read_age_ms: 120_000 }],
    });
    const after = Date.now();
    const rows = await deploys();
    const m = rows.find((d) => d.short_id === marked.deploy)!;
    const p = rows.find((d) => d.short_id === pass.deploys[0].deploy)!;
    expect(m.changes_read_at).toBeGreaterThanOrEqual(before - 60_000);
    expect(m.changes_read_at).toBeLessThanOrEqual(after - 60_000);
    expect(p.changes_read_at).toBeGreaterThanOrEqual(before - 120_000);
    expect(p.changes_read_at).toBeLessThanOrEqual(after - 120_000);
    expect(p).toMatchObject({ machine: "ana-mac", pushed_via: "deploy.sh", adds: ["fn:a:new"], drops: [] });
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

  test("`cast deploy --sha` of the live sha is refused only while prod runs its committed tree", async () => {
    const { t, ids, ship, save, request } = await withTarget();
    await onMain(t, ids.team, [1]);
    const S = shaN(1);
    const cancel = (id: string) => t.run(async (ctx) => ctx.db.patch(id as any, { status: "cancelled" }));
    await ship("ana", { sha: S });
    await expect(request({ sha: S })).rejects.toThrow("is already live on backend");
    await pause();
    // A dev push runs Ben's working tree on top: deploying the sha puts the commit back.
    await save("ben", { sha: S, dirty: 2 });
    const back = await request({ sha: S });
    expect(back).toMatchObject({ action: "deploy", sha: S, commits: 0 });
    await cancel(back._id);
    await pause();
    await ship("ana", { sha: S });
    await expect(request({ sha: S })).rejects.toThrow("is already live on backend");
    await pause();
    // A dirty deploy of the sha runs a working tree too.
    await ship("ana", { sha: S, dirty: 3 });
    expect(await request({ sha: S })).toMatchObject({ sha: S });
  });

  test("a pile of dev pushes after a deploy never hides it: it is live, the sha to put back, the way back, and the history is deploys only", async () => {
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
    // `cast deploy --sha` of the live deploy's sha puts its committed tree back over the dev pushes.
    const back = await request({ sha: sha(2) });
    expect(back).toMatchObject({ action: "deploy", sha: sha(2), commits: 0 });
    await t.run(async (ctx) => ctx.db.patch(back._id as any, { status: "cancelled" }));
    const reach = await t.withIdentity({ subject: `${ids.ana}|test` }).query(api.deployReach.get, { ref: `${REPO}@${sha(2)}` });
    expect(reach!.targets[0]).toMatchObject({ state: "live", deploy: { short_id: two.deploy } });
    // A rollback goes back to the deploy before it.
    expect(await request({ action: "rollback" })).toMatchObject({ action: "rollback", sha: sha(1) });
  });
});
