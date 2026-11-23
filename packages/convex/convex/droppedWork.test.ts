import { describe, expect, mock, test } from "bun:test";
import { api } from "./_generated/api";
import * as notificationRouter from "./notificationRouter";
import { HOUR, pause, REPO, setup, SHA2, SHA3, SHA4 } from "./deployRecord.testkit";

// Who put a dropped name on a target, and telling them their uncommitted work was dropped. Synthetic data only.

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
    const bens = await ship("ben", { sha: SHA2, changes_read_age_ms: Date.now() - t1 });
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
    await ship("ben", { sha: SHA2, changes_read_age_ms: Date.now() - read });
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
    const { t, ids, tokens, settle, save, notes } = await setup();
    await save("ben", { adds: ["table:voiceprints"] });
    await pause();
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.ana, team_id: ids.team, repository: REPO, ok: true, stage: "done", pushed: SHA2, commits: [], held: [], started_at: Date.now() - 1000,
      deploys: [{ name: "convex", stage: "deploy", ok: true, target: "backend", machine: "ana-mac", via: "deploy.sh", adds: ["fn:a:new"], drops: ["table:voiceprints"], changes_read_age_ms: 0 }],
    });
    await settle();
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

  test("a dev push's notice never quiets the same person's deploy dropping other work", async () => {
    const { ids, save, ship, notes } = await setup();
    const bens = await ship("ben", { sha: SHA2, dirty: 3, adds: ["fn:b:dirty"] });
    await pause();
    await save("ana", { drops: ["fn:b:dirty"] });
    await pause();
    await save("ben", { sha: SHA3, adds: ["table:bens"] });
    await pause();
    const anas = await ship("ana", { sha: SHA4, drops: ["table:bens"] });
    const rows = await notes();
    expect(rows.map((r) => [String(r.recipient_user_id), String(r.actor_user_id), r.link])).toEqual([
      [String(ids.ben), String(ids.ana), "/deploys"],
      [String(ids.ben), String(ids.ana), `/deploys?deploy=${anas.deploy}`],
    ]);
    expect(rows[0].entity_id).toBe(bens.deploy);
  });

  test("telling people runs after the push is recorded, in a write of its own", async () => {
    const { t, ids, tokens, settle, save, deploys, notes } = await setup();
    await save("ben", { adds: ["table:bens"] });
    await pause();
    const res = await t.mutation(api.changesDeploy.markDeploy, {
      api_token: tokens.ana, repository: REPO, surface: "backend", sha: SHA2, team_id: ids.team, via: "deploy.sh", machine: "ana-mac", adds: [], drops: ["table:bens"], changes_read_age_ms: 0,
    });
    expect(await notes()).toHaveLength(0);
    const jobs = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("tellDroppedWork")));
    expect(jobs).toHaveLength(1);
    await settle();
    expect(await notes()).toEqual([expect.objectContaining({ recipient_user_id: ids.ben, entity_id: res.deploy })]);
    expect(await deploys()).toHaveLength(1);
  });

  test("a notice that throws loses no push: the deploy and the dev push are recorded", async () => {
    const { t, ids, ship, save, deploys, devPushes, notes } = await setup();
    const real = { ...notificationRouter };
    mock.module("./notificationRouter", () => ({ ...real, emitNotification: async () => { throw new Error("notice failed"); } }));
    try {
      await save("ben", { adds: ["table:bens"] });
      await pause();
      const anas = await ship("ana", { sha: SHA2, drops: ["table:bens"] });
      expect(anas.deploy).toBeTruthy();
      await pause();
      await save("cy", { sha: SHA3, drops: ["table:bens"] });
      expect((await deploys()).map((d) => d.short_id)).toEqual([anas.deploy]);
      expect(await devPushes()).toHaveLength(2);
      expect(await notes()).toHaveLength(0);
      const jobs = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("tellDroppedWork")));
      expect(jobs.map((j: any) => j.state.kind)).toEqual(["failed", "failed"]);
      void ids;
    } finally {
      mock.module("./notificationRouter", () => real);
    }
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
