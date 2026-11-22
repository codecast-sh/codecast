import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { latestLiveDeploy, projectDeployViews, recordDeployMarker } from "./deploys";
import { deployLine } from "./deployTargetsState";
import { shapeView } from "./deploysView";

// Every push is recorded with what it put on the target and took off it, and
// whoever's uncommitted push put a dropped name there hears about it. The dev
// watcher's pushes are their own rows. Synthetic data only.

const REPO = "acme/app";
const SHA = "aaaaaaa1111111";
const SHA2 = "bbbbbbb2222222";

async function setup() {
  const t = convexTest(schema, allModules);
  const tokens = { ana: "deploy-record-ana", ben: "deploy-record-ben" };
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" });
    const ben = await ctx.db.insert("users", { name: "Ben" });
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    for (const [user, token] of [[ana, tokens.ana], [ben, tokens.ben]] as const) {
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: 1 } as any);
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "Test", created_at: 1, last_used_at: 1 });
    }
    return { ana, ben, team };
  });
  const mark = (who: "ana" | "ben", over: Record<string, any> = {}) =>
    t.mutation(api.changesDeploy.markDeploy, { api_token: tokens[who], repository: REPO, surface: "backend", sha: SHA, team_id: ids.team, ...over });
  const deploys = () => t.run(async (ctx) => (await ctx.db.query("deploys").collect()).sort((a, b) => a.created_at - b.created_at || a._creationTime - b._creationTime));
  const notes = () => t.run(async (ctx) => await ctx.db.query("notifications").collect());
  return { t, ids, tokens, mark, deploys, notes };
}

describe("the dev watcher's pushes", () => {
  test("a watcher push lands on its own last push of the sha, and nowhere else", async () => {
    const { mark, deploys } = await setup();
    const first = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 2, adds: ["fn:a:one"] });
    const again = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 3, adds: ["fn:a:two"], drops: ["fn:a:gone"] });
    expect(again.deploy).toBe(first.deploy);
    let rows = await deploys();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pushed_via: "dev watcher", machine: "ana-mac", dirty: 3, adds: ["fn:a:one", "fn:a:two"], drops: ["fn:a:gone"], status: "live" });

    // Another machine's push of the same sha is a deploy of its own.
    const other = await mark("ana", { via: "dev watcher", machine: "ana-mini", dirty: 1 });
    expect(other.deploy).not.toBe(first.deploy);
    // The first machine's next save goes back to its own row, which is what runs again.
    const back = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 3 });
    expect(back.deploy).toBe(first.deploy);
    // So is a deploy.sh push of it, even a dirty one, and it never lands on the watcher's row.
    const shipped = await mark("ana", { via: "deploy.sh", machine: "ana-mini", dirty: 1 });
    expect([first.deploy, other.deploy]).not.toContain(shipped.deploy);
    // The watcher's row is no longer the target's live deploy, so the next watcher push is a new row too.
    const later = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 4 });
    expect([first.deploy, other.deploy, shipped.deploy]).not.toContain(later.deploy);
    rows = await deploys();
    expect(rows).toHaveLength(4);
  });

  test("a watcher push never finishes a deploy the line asked for", async () => {
    const { t, ids, mark, deploys } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deploys", {
        short_id: "dp-900", workspace: `team:${ids.team}`, team_id: ids.team, target: "backend", status: "requested", trigger: "person",
        source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      });
    });
    const pushed = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1 });
    expect(pushed.deploy).not.toBe("dp-900");
    const asked = (await deploys()).find((d) => d.short_id === "dp-900")!;
    expect(asked.status).not.toBe("live");
    expect(asked.sha).toBeUndefined();
    expect(asked.pushed_via).toBeUndefined();
  });

  test("a watcher push leaves a waiting line deploy waiting; a deploy.sh push finishes it", async () => {
    const { t, ids, mark, deploys } = await setup();
    const ask = (short_id: string) => t.run(async (ctx) => {
      await ctx.db.insert("deploys", {
        short_id, workspace: `team:${ids.team}`, team_id: ids.team, target: "backend", status: "requested", trigger: "person",
        source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      });
    });
    await ask("dp-901");
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1 });
    expect((await deploys()).find((d) => d.short_id === "dp-901")!.status).toBe("requested");
    // A real deploy finishes it.
    await mark("ana", { via: "deploy.sh", sha: SHA2 });
    expect((await deploys()).find((d) => d.short_id === "dp-901")).toMatchObject({ status: "live", sha: SHA2 });
  });
});

describe("a deploy.sh push of a sha", () => {
  test("a dirty push lands on no live deploy of the same sha, clean or dirty: each is a deploy of its own", async () => {
    const { mark, deploys } = await setup();
    // Pushes minutes apart in life; a few milliseconds here so no two share an event (its key holds the millisecond).
    const pause = () => new Promise((r) => setTimeout(r, 5));
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
    expect(rows.find((d) => d.short_id === dirtyAgain.deploy)).toMatchObject({ dirty: 84, adds: ["fn:x:y"] });
  });

  test("adds and drops are capped at 500 names of 200 characters, tables, indexes and routes kept before functions", async () => {
    const { t, ids, deploys } = await setup();
    // The functions come first and fill the cap; the tables, indexes and routes at the end are what an incident is about.
    const names = [...Array.from({ length: 600 }, (_, i) => `fn:m:f${String(i).padStart(3, "0")}`), "http:GET /z", "index:t.by_a", "table:t", `table:${"x".repeat(300)}`];
    await t.run(async (ctx) => {
      await recordDeployMarker(ctx, { workspace: `team:${ids.team}`, team_id: ids.team, target: "backend", sha: SHA, repository: REPO, source: "test", pushed_via: "deploy.sh", adds: names, drops: names, at: Date.now() });
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

  test("a push that changed what runs is recorded even at the sha already live", async () => {
    const { mark, deploys } = await setup();
    await mark("ana", { via: "deploy.sh" });
    const again = await mark("ana", { via: "deploy.sh", drops: ["index:t.by_x"] });
    expect(again.deploy).toBeTruthy();
    expect((await deploys()).some((d) => d.drops?.includes("index:t.by_x"))).toBe(true);
  });
});

describe("who added a name", () => {
  test("each name answers with the latest deploy that added it; names never added are left out", async () => {
    const { t, ids, tokens, mark } = await setup();
    const one = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 2, adds: ["table:voiceprints", "index:voiceprints.by_user"] });
    const two = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: SHA2, adds: ["index:voiceprints.by_user"] });
    const { found } = await t.query(api.changesDeploy.addedBy, {
      api_token: tokens.ana, repository: REPO, surface: "backend", team_id: ids.team,
      names: ["table:voiceprints", "index:voiceprints.by_user", "fn:never:added"],
    });
    expect(found).toHaveLength(2);
    expect(found.find((f) => f.name === "table:voiceprints")).toMatchObject({ deploy: one.deploy, by: "Ben", machine: "ben-mac", via: "dev watcher", dirty: 2 });
    expect(found.find((f) => f.name === "index:voiceprints.by_user")).toMatchObject({ deploy: two.deploy, by: "Ana", machine: "ana-mac", via: "deploy.sh", dirty: 0 });
  });
});

describe("telling people their dropped work", () => {
  test("the person whose uncommitted push added a dropped name hears it once; clean commits and the pusher do not", async () => {
    const { ids, mark, notes } = await setup();
    // A clean commit of Ben's added a function; then his watcher put an index and a table up from his working tree.
    await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: SHA2, adds: ["fn:clean:commit"] });
    const bens = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 2, adds: ["index:voiceprints.by_user", "table:voiceprints"] });
    // Ana's own dirty push added something too.
    await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: "ccccccc3333333", dirty: 1, adds: ["fn:ana:own"] });
    // Ana's watcher push from main drops all of it, then pushes the same sha again with the same drops.
    const drops = ["index:voiceprints.by_user", "table:voiceprints", "fn:clean:commit", "fn:ana:own"];
    const anas = await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: "ddddddd4444444", drops });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: "ddddddd4444444", drops, dirty: 1 });

    const rows = await notes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_user_id: ids.ben,
      type: "deploy_dropped_work",
      actor_user_id: ids.ana,
      entity_type: "deploy",
      entity_id: anas.deploy,
      link: `/deploys?deploy=${anas.deploy}`,
      message: `${anas.deploy} dropped 2 things your watcher push ${bens.deploy} put on backend: index:voiceprints.by_user, table:voiceprints`,
    });
  });

  test("a long list names five and counts the rest", async () => {
    const { mark, notes } = await setup();
    const names = Array.from({ length: 8 }, (_, i) => `fn:m:f${i}`);
    await mark("ben", { via: "deploy.sh", dirty: 3, adds: names });
    await mark("ana", { via: "deploy.sh", sha: SHA2, drops: names });
    const [row] = await notes();
    expect(row.message).toEndWith("fn:m:f0, fn:m:f1, fn:m:f2, fn:m:f3, fn:m:f4 and 3 more");
  });
});

describe("review fixes", () => {
  test("a ship pass's deploy step records the push's machine, path, adds and drops, and its drops tell the adder", async () => {
    const { t, ids, tokens, mark, deploys, notes } = await setup();
    const bens = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 1, adds: ["table:voiceprints"] });
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, ok: true, stage: "done", pushed: SHA2, commits: [], held: [], started_at: Date.now() - 1000,
      deploys: [{ name: "convex", stage: "deploy", ok: true, target: "backend", machine: "ana-mac", via: "deploy.sh", adds: ["fn:a:new"], drops: ["table:voiceprints"] }],
    });
    const shipped = pass.deploys[0].deploy!;
    expect((await deploys()).find((d) => d.short_id === shipped)).toMatchObject({ machine: "ana-mac", pushed_via: "deploy.sh", adds: ["fn:a:new"], drops: ["table:voiceprints"] });
    const rows = await notes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_user_id: ids.ben, entity_id: shipped, message: `${shipped} dropped 1 thing your watcher push ${bens.deploy} put on backend: table:voiceprints` });
  });

  test("a name a clean deploy.sh push later kept counts as committed: dropping it tells nobody, and added-by says where it was committed", async () => {
    const { t, ids, tokens, mark, notes } = await setup();
    const bens = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 2, adds: ["table:voiceprints"] });
    // Main's next clean deploy kept the table (its diff ran and dropped nothing): Ben's work was committed by then.
    const kept = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: SHA2, adds: [], drops: [] });
    // Months later Ana removes it on purpose.
    const removal = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: "ccccccc3333333", drops: ["table:voiceprints"] });
    expect(await notes()).toHaveLength(0);
    const { found } = await t.query(api.changesDeploy.addedBy, { api_token: tokens.ana, repository: REPO, surface: "backend", team_id: ids.team, names: ["table:voiceprints"] });
    expect(found).toEqual([expect.objectContaining({ name: "table:voiceprints", deploy: bens.deploy, committed_in: kept.deploy })]);
    expect(removal.deploy).toBeTruthy();
  });

  test("a clean deploy after the name was dropped is no proof it was committed", async () => {
    const { t, ids, tokens, mark } = await setup();
    await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 2, adds: ["table:voiceprints"] });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: SHA2, dirty: 1, drops: ["table:voiceprints"] });
    await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: "ccccccc3333333" });
    const { found } = await t.query(api.changesDeploy.addedBy, { api_token: tokens.ana, repository: REPO, surface: "backend", team_id: ids.team, names: ["table:voiceprints"] });
    expect(found).toHaveLength(1);
    expect(found[0].committed_in).toBeUndefined();
  });

  test("two watchers dropping each other's work on every save tell each person once per six hours", async () => {
    const { t, ids, mark, notes, deploys } = await setup();
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: SHA, dirty: 1, adds: ["fn:a:x"], drops: i ? ["fn:b:y"] : [] });
      else await mark("ben", { via: "dev watcher", machine: "ben-mac", sha: SHA2, dirty: 1, adds: ["fn:b:y"], drops: ["fn:a:x"] });
    }
    // Each machine keeps one row for its sha between real deploys, and one event for it.
    expect(await deploys()).toHaveLength(2);
    expect(await t.run(async (ctx) => (await ctx.db.query("external_events").collect()).filter((e) => e.kind === "deploy"))).toHaveLength(2);
    let rows = await notes();
    expect(rows.map((r) => String(r.recipient_user_id)).sort()).toEqual([String(ids.ana), String(ids.ben)].sort());
    // Past the quiet window, the next drop is told again, and links to the deploy that dropped it.
    await t.run(async (ctx) => {
      for (const n of await ctx.db.query("notifications").collect()) await ctx.db.patch(n._id, { created_at: n.created_at - 7 * 60 * 60 * 1000 });
    });
    const next = await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: SHA, dirty: 1, adds: ["fn:a:x"], drops: ["fn:b:y"] });
    rows = await notes();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.entity_id === next.deploy)).toMatchObject({ recipient_user_id: ids.ben, link: `/deploys?deploy=${next.deploy}` });
  });

  test("a clean deploy.sh push of a sha the watcher pushed dirty is recorded; a repeat of it is not", async () => {
    const { mark, deploys } = await setup();
    const watcher = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 2 });
    const clean = await mark("ana", { via: "deploy.sh", machine: "ana-mac" });
    expect(clean.deploy).toBeTruthy();
    expect(clean.deploy).not.toBe(watcher.deploy);
    const rows = await deploys();
    expect(rows).toHaveLength(2);
    expect(rows.find((d) => d.short_id === clean.deploy)).toMatchObject({ pushed_via: "deploy.sh", status: "live" });
    expect(rows.find((d) => d.short_id === clean.deploy)!.dirty).toBeUndefined();
    await mark("ana", { via: "deploy.sh", machine: "ana-mac" });
    expect(await deploys()).toHaveLength(2);
  });

  test("repeated watcher saves of one sha keep one event on the one row", async () => {
    const { t, mark, deploys } = await setup();
    for (let i = 1; i <= 5; i++) await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: i, adds: [`fn:a:f${i}`] });
    const rows = await deploys();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_ids).toHaveLength(1);
    const events = await t.run(async (ctx) => (await ctx.db.query("external_events").collect()).filter((e) => e.kind === "deploy"));
    expect(events).toHaveLength(1);
    expect(String(events[0]._id)).toBe(String(rows[0].event_ids[0]));
    // Another machine's save is a push of its own, with its own event.
    await mark("ana", { via: "dev watcher", machine: "ana-mini", dirty: 1 });
    const after = await t.run(async (ctx) => (await ctx.db.query("external_events").collect()).filter((e) => e.kind === "deploy"));
    expect(after).toHaveLength(2);
  });

  test("a targets-view row counts the names; the deploy's own view lists them", async () => {
    const { t, mark, deploys } = await setup();
    await mark("ana", { via: "deploy.sh", machine: "ana-mac", adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
    const [row] = await deploys();
    const { line, view } = await t.run(async (ctx) => ({
      line: await deployLine(ctx, row, { conv: new Map(), task: new Map() }),
      view: await shapeView(ctx, row),
    }));
    expect(line).toMatchObject({ machine: "ana-mac", pushed_via: "deploy.sh", dirty: null, adds_count: 2, drops_count: 1 });
    expect("adds" in line).toBe(false);
    expect("drops" in line).toBe(false);
    expect(view).toMatchObject({ adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
  });

  test("the words say watcher push for a watcher's adds and uncommitted push for a dirty deploy.sh's", async () => {
    const { ids, mark, notes } = await setup();
    const dirty = await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: SHA2, dirty: 3, adds: ["fn:b:dirty"] });
    const watcher = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 1, adds: ["fn:b:watched"] });
    const drop = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: "ccccccc3333333", drops: ["fn:b:dirty", "fn:b:watched"] });
    const [row] = await notes();
    expect(row).toMatchObject({ recipient_user_id: ids.ben });
    expect(row.message).toBe(`${drop.deploy} dropped 2 things your watcher and uncommitted pushes ${dirty.deploy}, ${watcher.deploy} put on backend: fn:b:dirty, fn:b:watched`);
  });

  test("a workflow run's live marker lands on the target's live deploy of its sha, past a watcher push", async () => {
    const { t, ids, mark, deploys } = await setup();
    const shipped = await mark("ana", { via: "deploy.sh", machine: "ana-mac" });
    await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 1 });
    const run = await t.run(async (ctx) =>
      recordDeployMarker(ctx, { workspace: `team:${ids.team}`, team_id: ids.team, target: "backend", sha: SHA, repository: REPO, source: "github", workflow_run: "4242", status: "live", at: Date.now() }),
    );
    expect(run).toBe(shipped.deploy);
    expect(await deploys()).toHaveLength(2);
  });
});

describe("round-two fixes", () => {
  test("a clean redeploy of a sha after another push of it went live is a deploy of its own, and the target runs it", async () => {
    const { t, ids, mark, deploys, notes } = await setup();
    // Pushes minutes apart in life; a few milliseconds here so no two go live in the same one.
    const pause = () => new Promise((r) => setTimeout(r, 5));
    const bens = await mark("ben", { via: "deploy.sh", machine: "ben-mac" });
    await pause();
    const watcher = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 2, adds: ["table:foo"] });
    await pause();
    const clean = await mark("ana", { via: "deploy.sh", machine: "ana-mac", drops: ["table:foo"] });
    expect([bens.deploy, watcher.deploy]).not.toContain(clean.deploy);
    const live = await t.run(async (ctx) => latestLiveDeploy(ctx, `team:${ids.team}`, "backend", REPO));
    expect(live?.short_id).toBe(clean.deploy);
    // Ana dropped her own watcher's table: nobody is told, least of all that Ben dropped it.
    expect(await notes()).toHaveLength(0);
    // A retry of the clean deploy.sh is the same marker.
    await mark("ana", { via: "deploy.sh", machine: "ana-mac" });
    expect(await deploys()).toHaveLength(3);
    // Clean, dirty, clean of one sha: the last clean push is its own row, and the one the target runs.
    await pause();
    const other = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: SHA2 });
    await pause();
    const dirty = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: SHA2, dirty: 3 });
    await pause();
    const again = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: SHA2 });
    expect([other.deploy, dirty.deploy]).not.toContain(again.deploy);
    expect((await t.run(async (ctx) => latestLiveDeploy(ctx, `team:${ids.team}`, "backend", REPO)))?.short_id).toBe(again.deploy);
  });

  test("a different pusher's drop inside the quiet window still tells the adder; the same pusher's does not", async () => {
    const { t, ids, mark, notes } = await setup();
    const cy = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Cy" });
      await ctx.db.insert("team_memberships", { user_id: user, team_id: ids.team, role: "member", joined_at: 1 } as any);
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken("deploy-record-cy"), name: "Test", created_at: 1, last_used_at: 1 });
      return user;
    });
    const markCy = (over: Record<string, any>) =>
      t.mutation(api.changesDeploy.markDeploy, { api_token: "deploy-record-cy", repository: REPO, surface: "backend", sha: SHA, team_id: ids.team, ...over });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1, adds: ["table:one"] });
    await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: SHA2, drops: ["table:one"] });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: SHA2, dirty: 1, adds: ["table:two"] });
    const cys = await markCy({ via: "deploy.sh", machine: "cy-mac", sha: "ccccccc3333333", drops: ["table:two"] });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: "ccccccc3333333", dirty: 1, adds: ["table:three"] });
    await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: "ddddddd4444444", drops: ["table:three"] });
    const rows = (await notes()).sort((a, b) => a._creationTime - b._creationTime);
    expect(rows.map((r) => [String(r.recipient_user_id), String(r.actor_user_id)])).toEqual([[String(ids.ana), String(ids.ben)], [String(ids.ana), String(cy)]]);
    expect(rows[1]).toMatchObject({ entity_id: cys.deploy, actor_name: "Cy" });
  });

  test("a push finishing a deploy a role asked for names the pusher as the dropper, and never tells them of their own", async () => {
    const { t, ids, mark, notes } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deploys", {
        short_id: "dp-950", workspace: `team:${ids.team}`, team_id: ids.team, target: "backend", status: "requested", trigger: "role",
        started_by: { kind: "role", name: "release" }, source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      });
    });
    const bens = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 1, adds: ["table:bar"] });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: SHA2, dirty: 1, adds: ["table:foo"] });
    const finished = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: "ccccccc3333333", drops: ["table:foo", "table:bar"] });
    expect(finished.deploy).toBe("dp-950");
    const rows = await notes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_user_id: ids.ben, actor_user_id: ids.ana, actor_name: "Ana", entity_id: "dp-950",
      message: `dp-950 dropped 1 thing your watcher push ${bens.deploy} put on backend: table:bar`,
    });
  });

  test("the line's deploy rows count the names; the deploy's own read lists them", async () => {
    const { t, ids, tokens, mark } = await setup();
    const pushed = await mark("ana", { via: "deploy.sh", machine: "ana-mac", adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
    const rows = await t.run(async (ctx) => projectDeployViews(ctx, { _id: "p", workspace: `team:${ids.team}` } as any, [REPO], 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ short_id: pushed.deploy, adds_count: 2, drops_count: 1, machine: "ana-mac", pushed_via: "deploy.sh" });
    expect("adds" in rows[0]).toBe(false);
    expect("drops" in rows[0]).toBe(false);
    const one = await t.query(api.deploys.get, { api_token: tokens.ana, ref: pushed.deploy! });
    expect(one).toMatchObject({ adds: ["fn:a:one", "fn:a:two"], drops: ["table:t"] });
  });

  test("a watcher push carries no fix: the next clean deploy outside the line carries it, and only it shows in the fix's deploys", async () => {
    const { t, ids, mark, deploys } = await setup();
    const now = Date.now();
    const task = await t.run(async (ctx) => {
      const project = await ctx.db.insert("projects", {
        user_id: ids.ana, team_id: ids.team, workspace: `team:${ids.team}`, title: "App", status: "active", created_at: now, updated_at: now,
        line_profile: { finders: [], changed_at: 1, root: "/repo", deploy: { command: "./deploy.sh", target: "backend", trigger: "person" } },
      } as any);
      const task = await ctx.db.insert("tasks", {
        user_id: ids.ana, team_id: ids.team, workspace: `team:${ids.team}`, project_id: project, short_id: "ct-1", title: "Totals round wrong",
        task_type: "task", priority: "medium", source: "human", status: "done", created_at: now, updated_at: now,
      } as any);
      await ctx.db.insert("workflow_runs", {
        user_id: ids.ana, workspace: `team:${ids.team}`, task_id: task, status: "completed", node_statuses: [], created_at: now - 60_000, updated_at: now - 60_000,
        merge: { sha: "eeeeeee5555555", branch: "fix/a", into: "main", at: now - 60_000 },
      } as any);
      return task;
    });
    const watcher = await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: "eeeeeee5555555", dirty: 1 });
    // Went live after the watcher's push, not in the same millisecond (a tie would order them either way).
    await new Promise((r) => setTimeout(r, 5));
    const clean = await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: SHA2 });
    const rows = await deploys();
    expect(rows.find((d) => d.short_id === watcher.deploy)!.carries).toEqual([]);
    expect(rows.find((d) => d.short_id === clean.deploy)!.carries.map((c) => String(c.task_id))).toEqual([String(task)]);
    const shown = await t.withIdentity({ subject: `${ids.ana}|test` }).query(api.deploys.forTask, { task_id: task });
    expect(shown.map((d: any) => d.short_id)).toEqual([clean.deploy]);
  });
  test("two watchers alternating saves keep one row per machine, the save that runs is the target's live deploy, and a line deploy waiting stays in reach", async () => {
    const { t, ids, mark, deploys } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deploys", {
        short_id: "dp-960", workspace: `team:${ids.team}`, team_id: ids.team, target: "backend", status: "requested", trigger: "person",
        source: "line", event_ids: [], carries: [], created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000,
      });
    });
    const live = () => t.run(async (ctx) => (await latestLiveDeploy(ctx, `team:${ids.team}`, "backend", REPO))?.short_id);
    let a = "", b = "";
    for (let i = 0; i < 150; i++) {
      if (i % 2 === 0) a = (await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1 })).deploy!;
      else b = (await mark("ben", { via: "dev watcher", machine: "ben-mac", sha: SHA2, dirty: 1 })).deploy!;
    }
    expect(await deploys()).toHaveLength(3);
    // Saves seconds apart in life; a few milliseconds here so no two go live in the same one.
    const pause = () => new Promise((r) => setTimeout(r, 5));
    await pause();
    await mark("ben", { via: "dev watcher", machine: "ben-mac", sha: SHA2, dirty: 1 });
    expect(await live()).toBe(b);
    await pause();
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1 });
    expect(await live()).toBe(a);
    // The line's deploy is still found and finished by the next real deploy.
    const shipped = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: "ccccccc3333333" });
    expect(shipped.deploy).toBe("dp-960");
    // After a real deploy, a watcher save starts a new row.
    const after = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1 });
    expect([a, b, "dp-960"]).not.toContain(after.deploy);
  });

  test("a clean deploy whose diff did not run (an older cast, which records no path or names) is no proof a name was committed", async () => {
    const { t, ids, tokens, mark, notes } = await setup();
    const bens = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 2, adds: ["table:voiceprints"] });
    await mark("ana", { sha: SHA2 });
    const drop = await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: "ccccccc3333333", drops: ["table:voiceprints"] });
    const rows = await notes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_user_id: ids.ben, entity_id: drop.deploy });
    const { found } = await t.query(api.changesDeploy.addedBy, { api_token: tokens.ana, repository: REPO, surface: "backend", team_id: ids.team, names: ["table:voiceprints"] });
    expect(found).toEqual([expect.objectContaining({ deploy: bens.deploy })]);
    expect(found[0].committed_in).toBeUndefined();
  });
});

describe("round-three fixes", () => {
  // Pushes minutes apart in life; a few milliseconds here so no two go live in the same one.
  const pause = () => new Promise((r) => setTimeout(r, 5));

  test("two people's uncommitted pushes of one HEAD are two deploys, and the second's drop of the first's work is told", async () => {
    const { t, ids, tokens, mark, deploys, notes } = await setup();
    const anas = await mark("ana", { via: "deploy.sh", machine: "ana-mac", dirty: 2, adds: ["table:anas"], drops: [] });
    await pause();
    const bens = await mark("ben", { via: "deploy.sh", machine: "ben-mac", dirty: 5, adds: ["fn:ben:x"], drops: ["table:anas"] });
    expect(bens.deploy).not.toBe(anas.deploy);
    const rows = await deploys();
    expect(rows.find((d) => d.short_id === anas.deploy)).toMatchObject({ started_by: { name: "Ana" }, machine: "ana-mac", dirty: 2, adds: ["table:anas"], drops: [] });
    expect(rows.find((d) => d.short_id === bens.deploy)).toMatchObject({ started_by: { name: "Ben" }, machine: "ben-mac", dirty: 5, adds: ["fn:ben:x"], drops: ["table:anas"] });
    const told = await notes();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ recipient_user_id: ids.ana, actor_user_id: ids.ben, entity_id: bens.deploy });
    // A ship pass's deploy step with uncommitted files is a deploy of its own too.
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, ok: true, stage: "done", pushed: SHA, commits: [], held: [], started_at: Date.now() - 1000,
      deploys: [{ name: "convex", stage: "deploy", ok: true, target: "backend", dirty: 3, machine: "ana-mac", via: "deploy.sh", adds: [], drops: [] }],
    });
    expect([anas.deploy, bens.deploy]).not.toContain(pass.deploys[0].deploy);
    expect(await deploys()).toHaveLength(3);
  });

  test("only a clean push that changed nothing lands on the clean live deploy of its sha; a dirty one still finishes the deploy it names", async () => {
    const { t, ids, deploys } = await setup();
    const ws = `team:${ids.team}`;
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

  test("the live deploy every reader goes on from is the last real one: a watcher push is no rollback point, no queue base, no range start, replaces nothing and ends no window", async () => {
    const { t, ids, tokens } = await setup();
    const ws = `team:${ids.team}`;
    const base = Date.now() - 100_000;
    const sha = (n: number) => String(n).repeat(40);
    await t.mutation(api.deployTargets.publish, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, root: "/repo",
      targets: [{ name: "backend", command: "./deploy.sh $sha", rollback: "./rollback.sh $sha", runs: "here", live: { kind: "marker" }, policy: "press", paths: ["convex/**"] }],
    });
    await t.run(async (ctx) => {
      for (const n of [1, 2, 3, 4]) {
        await ctx.db.insert("commits", {
          sha: sha(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: base, files_changed: 1, insertions: 1, deletions: 0,
          repository: REPO, team_id: ids.team, branch: "main", main_at: base + n * 1000,
          files: [{ filename: `convex/f${n}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 }],
        });
      }
    });
    const push = (n: number, at: number, over: Record<string, any> = {}) => t.run(async (ctx) =>
      recordDeployMarker(ctx, { workspace: ws, team_id: ids.team, target: "backend", sha: sha(n), repository: REPO, source: "test", pushed_via: "deploy.sh", machine: "ana-mac", at: base + at, ...over }));
    const one = await push(1, 10_000);
    const two = await push(2, 20_000);
    const watcher = await push(3, 30_000, { pushed_via: "dev watcher", dirty: 2 });

    // The targets view: the queue goes on from the last real deploy; what prod runs is shown beside it.
    const [backend] = (await t.query(api.deployTargets.view, { api_token: tokens.ana, team_id: ids.team, target: "backend" })).targets;
    expect(backend.live).toMatchObject({ short_id: two });
    expect(backend.running).toMatchObject({ short_id: watcher, pushed_via: "dev watcher" });
    expect(backend.queue.commits).toBe(2);
    // `cast deploy --sha`: the last real deploy's sha is what is already live.
    await expect(t.mutation(api.deployTargets.request, { api_token: tokens.ana, team_id: ids.team, target: "backend", sha: sha(2), here: true })).rejects.toThrow("is already live on backend");
    // A rollback goes back from the last real deploy to the one before it.
    const rollback = await t.mutation(api.deployTargets.request, { api_token: tokens.ana, team_id: ids.team, target: "backend", action: "rollback", here: true });
    expect(rollback).toMatchObject({ action: "rollback", sha: sha(1) });
    const asked = await t.run(async (ctx) => ctx.db.query("deploys").withIndex("by_short_id", (q) => q.eq("short_id", rollback.short_id)).first());
    expect(asked).toMatchObject({ rollback_of: one, previous_sha: sha(2) });
    await t.run(async (ctx) => ctx.db.patch(asked!._id, { status: "cancelled" }));

    // An error that started after the watcher push and before the next real deploy is in the real deploy's window.
    await t.run(async (ctx) => {
      const source_id = await ctx.db.insert("event_sources", { workspace: ws, owner_user_id: ids.ana, short_id: "src-1", provider: "sdk", name: "app", promote: [], status: "active", created_at: base, updated_at: base } as any);
      await ctx.db.insert("event_groups", { workspace: ws, source_id, short_id: "eg-1", kind: "error", fingerprint: "fp", title: "boom", status: "open", first_seen: base + 35_000, last_seen: base + 36_000, count: 1, buckets: [], updated_at: base } as any);
    });
    // The next real deploy's range starts at the last real deploy's sha, not the watcher's.
    const four = await push(4, 40_000);
    const four_row = await t.run(async (ctx) => ctx.db.query("deploys").withIndex("by_short_id", (q) => q.eq("short_id", four!)).first());
    expect(four_row).toMatchObject({ previous_sha: sha(2) });
    expect(four_row!.commits!.map((c) => c.sha)).toEqual([sha(4), sha(3)]);

    const got = (ref: string) => t.query(api.deploys.get, { api_token: tokens.ana, ref });
    const twoView = await got(two!);
    expect(twoView!.replaced_by).toMatchObject({ short_id: four });
    expect(twoView!.after).toMatchObject({ to: base + 40_000, new_errors: 1 });
    expect((await got(watcher!))!.replaced_by).toMatchObject({ short_id: four });
  });

  test("a clean deploy is proof a name was committed only when its diff ran", async () => {
    const { t, ids, tokens, mark, deploys } = await setup();
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1, adds: ["table:anas"], drops: [] });
    await pause();
    // Ben deploys main, but the diff could not read prod: no names sent.
    const blind = await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: SHA2 });
    const ask = async () => (await t.query(api.changesDeploy.addedBy, { api_token: tokens.ana, repository: REPO, surface: "backend", team_id: ids.team, names: ["table:anas"] })).found[0];
    expect((await ask()).committed_in).toBeUndefined();
    await pause();
    // A clean deploy whose diff ran and dropped nothing kept it; its empty lists are stored as sent.
    const kept = await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: "ccccccc3333333", adds: [], drops: [] });
    expect((await ask()).committed_in).toBe(kept.deploy);
    const rows = await deploys();
    expect(rows.find((d) => d.short_id === kept.deploy)).toMatchObject({ adds: [], drops: [] });
    expect("drops" in rows.find((d) => d.short_id === blind.deploy)!).toBe(false);
  });

  test("a drop older than the name's last add does not hide the clean deploy that kept it", async () => {
    const { t, mark, notes } = await setup();
    await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: SHA, dirty: 1, adds: ["fn:a:n"], drops: [] });
    await pause();
    await mark("ben", { via: "dev watcher", machine: "ben-mac", sha: SHA2, dirty: 1, adds: [], drops: ["fn:a:n"] });
    await pause();
    // Ana's watcher puts it back on its own row; she commits it, and the next clean deploy keeps it.
    await mark("ana", { via: "dev watcher", machine: "ana-mac", sha: SHA, dirty: 1, adds: ["fn:a:n"], drops: [] });
    await pause();
    await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: "ccccccc3333333", adds: [], drops: [] });
    const before = (await notes()).length;
    expect(before).toBe(1);
    // Weeks later it is removed on purpose, in a commit: nobody is told.
    await t.run(async (ctx) => {
      for (const n of await ctx.db.query("notifications").collect()) await ctx.db.patch(n._id, { created_at: n.created_at - 7 * 24 * 60 * 60 * 1000 });
    });
    await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: "ddddddd4444444", adds: [], drops: ["fn:a:n"] });
    expect(await notes()).toHaveLength(before);
  });

  test("a watcher row holds the net change of its saves, and a name it drops again after putting it back is told again", async () => {
    const { t, ids, mark, deploys, notes } = await setup();
    await mark("ben", { via: "dev watcher", machine: "ben-mac", sha: SHA2, dirty: 1, adds: ["fn:b:z"], drops: [] });
    await pause();
    const row = await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1, adds: ["fn:a:x"], drops: ["fn:b:z"] });
    expect(await notes()).toHaveLength(1);
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1, adds: ["fn:b:z"], drops: ["fn:a:x"] });
    expect((await deploys()).find((d) => d.short_id === row.deploy)).toMatchObject({ adds: ["fn:b:z"], drops: ["fn:a:x"] });
    // Past the quiet window, dropping it again is news to Ben.
    await t.run(async (ctx) => {
      for (const n of await ctx.db.query("notifications").collect()) await ctx.db.patch(n._id, { created_at: n.created_at - 7 * 60 * 60 * 1000 });
    });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1, adds: [], drops: ["fn:b:z"] });
    expect((await deploys()).find((d) => d.short_id === row.deploy)).toMatchObject({ adds: [], drops: ["fn:a:x", "fn:b:z"] });
    const told = await notes();
    expect(told).toHaveLength(2);
    expect(told.every((n) => String(n.recipient_user_id) === String(ids.ben))).toBe(true);
  });

  test("a watcher push fires no deploy trigger; a real deploy does", async () => {
    const { t, ids, mark } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_tasks", { user_id: ids.ana, title: "After a deploy", prompt: "x", schedule_type: "event", status: "scheduled", run_count: 0, event_filter: { event_type: "deploy_live" }, created_at: 0, updated_at: 0 } as any);
    });
    const matches = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f: any) => f.name.includes("matchTaskTriggers") && f.args[0]?.event_type === "deploy_live").length);
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 1, adds: ["fn:a:x"], drops: [] });
    await mark("ana", { via: "dev watcher", machine: "ana-mac", dirty: 2, adds: ["fn:a:y"], drops: [] });
    expect(await matches()).toBe(0);
    await mark("ana", { via: "deploy.sh", machine: "ana-mac", sha: SHA2, adds: [], drops: [] });
    expect(await matches()).toBe(1);
  });
});
