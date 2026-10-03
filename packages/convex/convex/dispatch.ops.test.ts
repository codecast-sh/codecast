// The Ops page's writes (external-data.md X10, web store/opsSlice.ts) ride
// dispatch side effects into the public ingest and app functions. These pin
// what each one lands, that the ingest key leaves the backend only in the
// create and rotate answers, and that a gesture on a stub row is dropped.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { sha256Hex } from "./lib/hash";

const api = anyApi as any;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./dispatch.ts": () => import("./dispatch"),
  "./ingest.ts": () => import("./ingest"),
  "./sources/app.ts": () => import("./sources/app"),
};

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com", active_team_id: team } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "member", joined_at: now } as any);
    return { team, ana, eve };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const dispatch = (u: string, action: string, args: unknown[]) => as(u).mutation(api.dispatch.dispatch, { action, args });
  return { t, ...ids, as, dispatch };
}

describe("ops dispatch side effects", () => {
  test("createOpsSource makes the source in the named workspace and hands back the key once, stored as a hash", async () => {
    const { t, team, ana, dispatch } = await seed();
    const out = await dispatch(String(ana), "createOpsSource", [{ name: " Web ", provider: "sdk", workspace: "team", team_id: String(team) }]);
    expect(out.name).toBe("web");
    expect(out.ingest_key).toMatch(/^cc_ing_/);
    const row = await t.run((ctx) => ctx.db.get(out.source_id));
    expect(row!.workspace).toBe(`team:${team}`);
    expect(row!.ingest_key_hash).toBe(await sha256Hex(out.ingest_key));

    const rotated = await dispatch(String(ana), "rotateOpsSourceKey", [out.source_id]);
    expect(rotated.ingest_key).not.toBe(out.ingest_key);
    expect(rotated.ingest_key.startsWith(rotated.key_prefix)).toBe(true);
  });

  test("pause, triage and remove land through the public functions", async () => {
    const { t, team, ana, dispatch } = await seed();
    const { source_id } = await dispatch(String(ana), "createOpsSource", [{ name: "api", provider: "http", workspace: "team", team_id: String(team) }]);
    await dispatch(String(ana), "setOpsSourceStatus", [source_id, "paused"]);
    expect((await t.run((ctx) => ctx.db.get(source_id)))!.status).toBe("paused");

    const now = Date.now();
    const group = await t.run((ctx) =>
      ctx.db.insert("event_groups", {
        workspace: `team:${team}`, team_id: team, source_id, short_id: "eg-1", kind: "error", fingerprint: "f", title: "Boom",
        status: "open", first_seen: now, last_seen: now, count: 1, buckets: [], updated_at: now,
      } as any),
    );
    await dispatch(String(ana), "setOpsGroupStatus", [group, "resolved"]);
    const g = await t.run((ctx) => ctx.db.get(group));
    expect(g!.status).toBe("resolved");
    expect(g!.resolved_at).toBeGreaterThan(0);

    await dispatch(String(ana), "removeOpsSource", [source_id]);
    expect(await t.run((ctx) => ctx.db.get(source_id))).toBeNull();
  });

  test("a gesture on a stub id is dropped, never an argument error the outbox re-drives", async () => {
    const { ana, dispatch } = await seed();
    await expect(dispatch(String(ana), "setOpsSourceStatus", ["temp_src_abc", "paused"])).resolves.toBeNull();
    await expect(dispatch(String(ana), "setOpsGroupStatus", ["temp", "resolved"])).resolves.toBeNull();
    await expect(dispatch(String(ana), "grantOpsAction", ["temp", "jobs.rerun"])).resolves.toBeNull();
    await expect(dispatch(String(ana), "rotateOpsSourceKey", ["temp"])).resolves.toBeNull();
  });

  test("someone outside the workspace cannot reach its source", async () => {
    const { team, ana, eve, dispatch } = await seed();
    const { source_id } = await dispatch(String(ana), "createOpsSource", [{ name: "web", provider: "sdk", workspace: "team", team_id: String(team) }]);
    await expect(dispatch(String(eve), "setOpsSourceStatus", [source_id, "paused"])).rejects.toThrow();
    await expect(dispatch(String(eve), "rotateOpsSourceKey", [source_id])).rejects.toThrow();
  });

  test("a grant names an action the manifest declares, and a revoke takes it away", async () => {
    const { t, team, ana, dispatch } = await seed();
    const now = Date.now();
    const source = await t.run((ctx) =>
      ctx.db.insert("event_sources", {
        workspace: `team:${team}`, team_id: team, owner_user_id: ana, short_id: "src-9", provider: "app", name: "union",
        manifest_json: JSON.stringify({ name: "union", version: "1", readers: [], actions: [{ name: "jobs.rerun", title: "Rerun", method: "POST", path: "/jobs/rerun", input: {}, idempotent: true, risk: "low" }], watches: [] }),
        manifest_fetched_at: now, promote: [], status: "active", created_at: now, updated_at: now,
      } as any),
    );
    await dispatch(String(ana), "grantOpsAction", [source, "jobs.rerun"]);
    let row = await t.run((ctx) => ctx.db.get(source));
    expect(row!.grants?.map((g: any) => [g.action, g.via])).toEqual([["jobs.rerun", "session"]]);
    await expect(dispatch(String(ana), "grantOpsAction", [source, "nope"])).rejects.toThrow(/declares no action/);
    await dispatch(String(ana), "revokeOpsAction", [source, "jobs.rerun"]);
    row = await t.run((ctx) => ctx.db.get(source));
    expect(row!.grants).toEqual([]);
  });
});
