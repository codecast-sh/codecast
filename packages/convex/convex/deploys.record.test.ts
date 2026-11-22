import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { recordDeployMarker } from "./deploys";

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
  test("a dirty push does not land on the clean deploy of the same sha, and a second dirty one lands on the first", async () => {
    const { mark, deploys } = await setup();
    const clean = await mark("ana", { via: "deploy.sh", machine: "ana-mac" });
    const dirty = await mark("ana", { via: "deploy.sh", machine: "ana-mac", dirty: 84 });
    expect(dirty.deploy).not.toBe(clean.deploy);
    const dirtyAgain = await mark("ana", { via: "deploy.sh", machine: "ana-mac", dirty: 84, adds: ["fn:x:y"] });
    expect(dirtyAgain.deploy).toBe(dirty.deploy);
    const rows = await deploys();
    expect(rows.find((d) => d.short_id === clean.deploy)!.dirty).toBeUndefined();
    expect(rows.find((d) => d.short_id === dirty.deploy)).toMatchObject({ dirty: 84, adds: ["fn:x:y"] });
  });

  test("adds and drops are capped at 500 names of 200 characters", async () => {
    const { t, ids, deploys } = await setup();
    const names = Array.from({ length: 600 }, (_, i) => `fn:m:f${i}`);
    names[0] = `fn:m:${"x".repeat(300)}`;
    await t.run(async (ctx) => {
      await recordDeployMarker(ctx, { workspace: `team:${ids.team}`, team_id: ids.team, target: "backend", sha: SHA, repository: REPO, source: "test", pushed_via: "deploy.sh", adds: names, drops: names, at: Date.now() });
    });
    const [row] = await deploys();
    expect(row.adds).toHaveLength(500);
    expect(row.drops).toHaveLength(500);
    expect(row.adds![0]).toHaveLength(200);
    expect(row.adds![499]).toBe("fn:m:f499");
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
    // Ben's watcher put an index and a table up from his working tree; a clean commit of his added a function.
    const bens = await mark("ben", { via: "dev watcher", machine: "ben-mac", dirty: 2, adds: ["index:voiceprints.by_user", "table:voiceprints"] });
    await mark("ben", { via: "deploy.sh", machine: "ben-mac", sha: SHA2, adds: ["fn:clean:commit"] });
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
      message: `${anas.deploy} dropped 2 things your uncommitted push ${bens.deploy} put on backend: index:voiceprints.by_user, table:voiceprints`,
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
