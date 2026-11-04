// A watch made, edited and removed from the web (store/opsSlice.ts
// createOpsWatch, updateOpsWatch, removeOpsWatch): each rides a dispatch side
// effect into the metrics functions the CLI calls, in the source's own
// workspace, and a gesture on a stub id or outside the workspace lands nothing.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";

const api = anyApi as any;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./dispatch.ts": () => import("./dispatch"),
  "./ingest.ts": () => import("./ingest"),
  "./metrics.ts": () => import("./metrics"),
};

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com", active_team_id: team } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "member", joined_at: now } as any);
    const source = await ctx.db.insert("event_sources", {
      workspace: `team:${team}`, team_id: team, owner_user_id: ana, short_id: "src-1", provider: "posthog", name: "union-posthog",
      promote: ["new", "regressed"], status: "active", created_at: now, updated_at: now,
    } as any);
    return { team, ana, eve, source };
  });
  const dispatch = (u: string, action: string, args: unknown[]) => t.withIdentity({ subject: `${u}|test` }).mutation(api.dispatch.dispatch, { action, args });
  return { t, ...ids, dispatch };
}

describe("watch dispatch side effects", () => {
  test("create in the source's workspace, then move the line, flip the side, pause and remove", async () => {
    const { t, team, ana, source, dispatch } = await seed();
    const made = await dispatch(String(ana), "createOpsWatch", [{ source: String(source), name: " Exceptions ", query_kind: "hogql", query: "select count() from events", threshold: 15, direction: "above", interval_ms: 3600_000 }]);
    expect(made.short_id).toMatch(/^mw-/);
    const row = () => t.run((ctx) => ctx.db.get(made.watch_id));
    expect(await row()).toMatchObject({ workspace: `team:${team}`, name: "Exceptions", threshold: 15, direction: "above", interval_ms: 3600_000, status: "active" });

    await dispatch(String(ana), "updateOpsWatch", [made.watch_id, { threshold: 40, direction: "below", unit: "%", name: "Errors" }]);
    expect(await row()).toMatchObject({ threshold: 40, direction: "below", unit: "%", name: "Errors" });

    await dispatch(String(ana), "updateOpsWatch", [made.watch_id, { threshold: null }]);
    expect((await row())!.threshold).toBeUndefined();

    await dispatch(String(ana), "updateOpsWatch", [made.watch_id, { status: "paused" }]);
    expect((await row())!.status).toBe("paused");
    expect((await row())!.next_check_at).toBeUndefined();

    await dispatch(String(ana), "removeOpsWatch", [made.watch_id]);
    expect(await row()).toBeNull();
  });

  test("a query the source cannot run is refused before it is stored", async () => {
    const { ana, source, dispatch } = await seed();
    await expect(dispatch(String(ana), "createOpsWatch", [{ source: String(source), name: "R", query_kind: "reader", query: "signups" }])).rejects.toThrow(/cannot watch a reader/);
  });

  test("a stub id is dropped, and someone outside the workspace cannot reach the watch", async () => {
    const { t, ana, eve, source, dispatch } = await seed();
    expect(await dispatch(String(ana), "updateOpsWatch", ["temp_w", { threshold: 1 }])).toBeNull();
    const made = await dispatch(String(ana), "createOpsWatch", [{ source: String(source), name: "E", query_kind: "insight", query: "abc123", threshold: 1 }]);
    await expect(dispatch(String(eve), "updateOpsWatch", [made.watch_id, { threshold: 99 }])).rejects.toThrow();
    expect((await t.run((ctx) => ctx.db.get(made.watch_id)))!.threshold).toBe(1);
  });
});
