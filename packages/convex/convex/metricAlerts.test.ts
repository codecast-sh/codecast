import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { createSource } from "./ingest";
import { createWatch, recordPoint, updateWatch } from "./metrics";

const h = (fn: any) => fn._handler;

function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", name: "Ada", github_username: "ada", active_team_id: "team_1" }, { _id: "u2", name: "Out" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      projects: [],
      event_sources: [],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      conversations: [],
      metric_watches: [],
      notifications: [],
      entity_subscriptions: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, as, internalCtx: { db, scheduler } as any };
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

async function watch(w: ReturnType<typeof world>) {
  await h(createSource)(w.as("u1"), { ...TEAM, name: "product", provider: "posthog" });
  return (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "Errors", query_kind: "hogql", query: "select 1", threshold: 10, direction: "above" })).watch;
}

const point = (w: ReturnType<typeof world>, id: string, value: number, at = Date.now()) => h(recordPoint)(w.internalCtx, { watch_id: id, at, value });
const row = (w: ReturnType<typeof world>) => w.db._tables.metric_watches[0];

describe("alert routing", () => {
  test("a person named hears the crossing once, again past the renotify interval, and the recovery; each is kept on the watch", async () => {
    const w = world();
    const mw = await watch(w);
    await h(updateWatch)(w.as("u1"), { ...TEAM, watch: mw.short_id, notify: { users: ["u1"], renotify_ms: 3600_000, recovery: true } });
    expect(row(w).notify).toEqual({ users: ["u1"], renotify_ms: 3600_000, recovery: true, by: "u1" });

    await point(w, mw._id, 5);
    expect(w.db._tables.notifications).toHaveLength(0);

    await point(w, mw._id, 15);
    const bell = w.db._tables.notifications;
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ recipient_user_id: "u1", type: "metric_alert", entity_type: "metric_watch", entity_id: "mw-1", link: "/ops/metrics/mw-1" });
    expect(bell[0].message).toContain("mw-1 Errors crossed its line: 15, line > 10");
    expect(row(w).deliveries).toMatchObject([{ kind: "crossed", to: "@ada", ok: true }]);
    expect(row(w).alert_episode).toBeTruthy();

    // Still past the line, inside the interval: nothing new.
    await point(w, mw._id, 16);
    expect(w.db._tables.notifications).toHaveLength(1);

    // The interval has passed since it was last said.
    await w.db.patch(row(w)._id, { alert_episode: { ...row(w).alert_episode, notified_at: Date.now() - 2 * 3600_000 } });
    await point(w, mw._id, 17);
    expect(w.db._tables.notifications).toHaveLength(2);
    expect(w.db._tables.notifications[1].message).toContain("still alerting");
    expect(row(w).deliveries.map((d: any) => d.kind)).toEqual(["crossed", "still"]);

    await point(w, mw._id, 3);
    expect(w.db._tables.notifications).toHaveLength(3);
    expect(w.db._tables.notifications[2].message).toContain("recovered: 3");
    expect(row(w).deliveries.map((d: any) => d.kind)).toEqual(["crossed", "still", "recovered"]);
    expect(row(w).alert_episode).toBeUndefined();
  });

  test("someone outside the workspace cannot be named, and clearing the setting stores nothing", async () => {
    const w = world();
    const mw = await watch(w);
    await expect(h(updateWatch)(w.as("u1"), { ...TEAM, watch: mw.short_id, notify: { users: ["u2"] } })).rejects.toThrow(/not in this workspace/);
    await h(updateWatch)(w.as("u1"), { ...TEAM, watch: mw.short_id, notify: { users: ["u1"] } });
    await h(updateWatch)(w.as("u1"), { ...TEAM, watch: mw.short_id, notify: null });
    expect(row(w).notify).toBeUndefined();
    await point(w, mw._id, 15);
    expect(w.db._tables.notifications).toHaveLength(0);
  });

  test("a fix that would start on its own says why it could not when the source has no project", async () => {
    const w = world();
    const mw = await watch(w);
    await h(updateWatch)(w.as("u1"), { ...TEAM, watch: mw.short_id, notify: { fix: true } });
    await point(w, mw._id, 15);
    expect(row(w).deliveries).toMatchObject([{ kind: "crossed", to: "fix session", ok: false, note: "product has no project folder" }]);
    expect(w.db._tables.conversations).toHaveLength(0);
  });
});
