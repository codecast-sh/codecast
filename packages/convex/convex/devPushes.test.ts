import { describe, expect, test } from "bun:test";
import { HOUR, pause, REPO, setup, SHA, SHA2, SHA3 } from "./deployRecord.testkit";

// A dev watcher's push is recorded as a dev push, in a table of its own, and never a deploy. Synthetic data only.

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

  test("the watcher's start-up push of the committed tree the clean live deploy runs changed nothing: nothing is recorded", async () => {
    const { ship, save, devPushes } = await setup();
    await ship("ana");
    await pause();
    expect(await save("ben", { dirty: 0 })).toMatchObject({ ok: true, dev_push: false, noop: true, deploy: null, event_id: null });
    expect(await devPushes()).toHaveLength(0);
    // Over a dev push, the committed tree changes what runs.
    await save("ben", { dirty: 2 });
    await pause();
    expect(await save("cy", { dirty: 0 })).toMatchObject({ dev_push: true });
    expect(await devPushes()).toHaveLength(2);
    // So do uncommitted files, a name it added or dropped, and another sha.
    for (const over of [{ dirty: 2 }, { dirty: 0, adds: ["fn:b:x"] }, { dirty: 0, drops: ["fn:a:y"] }, { dirty: 0, sha: SHA2 }]) {
      const s = await setup();
      await s.ship("ana");
      await pause();
      expect(await s.save("ben", over)).toMatchObject({ dev_push: true });
      expect(await s.devPushes()).toHaveLength(1);
    }
  });

  test("the watcher's push of a committed tree over a dirty live deploy of its sha is recorded", async () => {
    const { ship, save, devPushes } = await setup();
    await ship("ana", { dirty: 3 });
    await pause();
    expect(await save("ben", { dirty: 0 })).toMatchObject({ dev_push: true });
    expect(await devPushes()).toHaveLength(1);
  });
});
