// The line's web read of a moment (lineMoments.ts): a member of the moment's
// workspace reads it with its source, trigger refs and judge runs; anyone
// else reads nothing.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";

const T0 = Date.now();

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const stranger = await ctx.db.insert("users", { name: "Bo" } as any);
    const team = await ctx.db.insert("teams", { name: "Product", created_at: T0, invite_code: "x" } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: T0 } as any);
    const workspace = `team:${team}`;
    const source = await ctx.db.insert("event_sources", { workspace, team_id: team, owner_user_id: user, short_id: "src-1", provider: "http", name: "app", promote: [], status: "active", created_at: T0, updated_at: T0 } as any);
    const moment = await ctx.db.insert("moments", {
      workspace, team_id: team, source_id: source, short_id: "mo-7", kind: "call", subject: "c_1", status: "ready", events: 2, first_event_at: T0 - 9_000, event_at: T0,
      refs_json: JSON.stringify({ call: "c_1" }), due_at: T0, attempts: 1, extracted_at: T0 + 1000, gap_ms: 1000, storage: "host", blocks: 3, created_at: T0, updated_at: T0,
    } as any);
    const judge = await ctx.db.insert("judges", {
      workspace, team_id: team, source_id: source, name: "comms", version: "a".repeat(40), path: "j.md", moment_kind: "call", model: "m", max_tokens: 800,
      projects: [], project_ids: [], mode: "live", prompt: "p", publisher_user_id: user, published_at: T0,
    } as any);
    await ctx.db.insert("judge_runs", {
      workspace, team_id: team, source_id: source, judge_id: judge, judge: "comms", judge_version: "a".repeat(40), moment_id: moment, moment_short_id: "mo-7", mode: "live", status: "ok",
      expectations: [], findings_json: JSON.stringify([{ expectation: "ex-aq-1", severity: 8, what_happened: "No reply.", quote: "call me", markers: [] }]), findings: 1, model: "m", cost_usd: 0.01, at: T0 + 2000,
    } as any);
    return { user, stranger, moment };
  });
  return { t, ids };
}

describe("lineMoments", () => {
  test("a member reads the moment, its trigger and its judge runs", async () => {
    const { t, ids } = await setup();
    const m = await t.withIdentity({ subject: `${ids.user}|test` }).query(api.lineMoments.momentForWeb, { moment: "mo-7" });
    expect(m).toMatchObject({ _id: "mo-7", kind: "call", subject: "c_1", source: "app", refs: { call: "c_1" }, kept: false, storage: "host", blocks: 3 });
    expect(m!.runs).toHaveLength(1);
    expect(m!.runs[0]).toMatchObject({ judge: "comms", status: "ok", filed: 0, findings: [{ expectation: "ex-aq-1", severity: 8, quote: "call me" }] });
  });

  test("a stranger and a signed-out viewer read nothing", async () => {
    const { t, ids } = await setup();
    expect(await t.withIdentity({ subject: `${ids.stranger}|test` }).query(api.lineMoments.momentForWeb, { moment: "mo-7" })).toBeNull();
    expect(await t.query(api.lineMoments.momentForWeb, { moment: "mo-7" })).toBeNull();
    expect(await t.withIdentity({ subject: `${ids.stranger}|test` }).action(api.lineMoments.momentBodyForWeb, { moment: "mo-7" })).toBeNull();
  });

  test("a kept body's key goes to a member while it is kept, never to a stranger or past its expiry", async () => {
    const { t, ids } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.moment, { storage: "convex", body_key: "moments/mo-7.json.gz", body_expires_at: Date.now() + 86_400_000 } as any));
    expect(await t.query(internal.lineMoments.bodyKeyForWeb, { user_id: ids.user, moment: "mo-7" })).toBe("moments/mo-7.json.gz");
    expect(await t.query(internal.lineMoments.bodyKeyForWeb, { user_id: ids.stranger, moment: "mo-7" })).toBeNull();
    await t.run((ctx) => ctx.db.patch(ids.moment, { body_expires_at: Date.now() - 1 } as any));
    expect(await t.query(internal.lineMoments.bodyKeyForWeb, { user_id: ids.user, moment: "mo-7" })).toBeNull();
  });
});
