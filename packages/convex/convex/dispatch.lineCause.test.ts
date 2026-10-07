// Changing the line with an agent (line-map.md LX6) through dispatch: the
// composer's fileLineCause files a cause in the project, category line, the
// node its subject and the person's words its first signal, through the signal
// door's commit; a replay of the same client key finds the cause it made; and
// startLineCause refuses a cause no role's line can run.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";

const api = anyApi as any;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./dispatch.ts": () => import("./dispatch"),
  "./users.ts": () => import("./users"),
  "./signals.ts": () => import("./signals"),
  "./notificationRouter.ts": () => import("./notificationRouter"),
};

const FIELDS = { subject: "line:station:prove", title: "Prove keeps picking moments from last month", detail_md: "Prove should pick moments from this week." };

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    const project = await ctx.db.insert("projects", { user_id: ana, workspace: `user:${ana}`, title: "Codecast", status: "active", created_at: now, updated_at: now } as any);
    return { ana, eve, project };
  });
  const dispatch = (u: string, action: string, args: unknown[]) => t.withIdentity({ subject: `${u}|test` }).mutation(api.dispatch.dispatch, { action, args });
  return { t, ...ids, dispatch };
}

describe("fileLineCause", () => {
  test("files a cause in the project: category line, the client's key, the words as a person's request signal on the node", async () => {
    const { t, ana, project, dispatch } = await seed();
    const out = await dispatch(String(ana), "fileLineCause", ["lc1", String(project), FIELDS]);
    expect(out.task_short_id).toMatch(/^ct-/);
    const task: any = await t.run((ctx) => ctx.db.get(out.task_id));
    expect(task).toMatchObject({
      title: FIELDS.title, category: "line", client_key: "lc1", project_id: project, source: "signal",
      triage_status: "suggested", status: "open", task_type: "feature", workspace: `user:${ana}`,
    });
    const signals = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: "person", kind: "request", subject: "line:station:prove", fingerprint: "line:station:prove#lc1", task_id: out.task_id, project_id: project, detail_md: FIELDS.detail_md });
  });

  test("a replay of the same key answers the cause it made; a second request on the node opens its own", async () => {
    const { t, ana, project, dispatch } = await seed();
    const a = await dispatch(String(ana), "fileLineCause", ["lc1", String(project), FIELDS]);
    const again = await dispatch(String(ana), "fileLineCause", ["lc1", String(project), FIELDS]);
    expect(again.task_id).toBe(a.task_id);
    const b = await dispatch(String(ana), "fileLineCause", ["lc2", String(project), FIELDS]);
    expect(b.task_id).not.toBe(a.task_id);
    expect(await t.run((ctx) => ctx.db.query("signals").collect())).toHaveLength(2);
  });

  test("refuses a subject outside the line, a project the viewer cannot see, and a project not saved yet", async () => {
    const { ana, eve, project, dispatch } = await seed();
    await expect(dispatch(String(ana), "fileLineCause", ["lc1", String(project), { ...FIELDS, subject: "web/checkout" }])).rejects.toThrow(/names a node of the line/);
    await expect(dispatch(String(eve), "fileLineCause", ["lc1", String(project), FIELDS])).rejects.toThrow(/Project not found/);
    await expect(dispatch(String(ana), "fileLineCause", ["lc1", "temp_project_x", FIELDS])).rejects.toThrow(/not saved yet/);
  });
});

describe("startLineCause", () => {
  test("refuses a cause still being filed, and one whose project no role leads", async () => {
    const { ana, project, dispatch } = await seed();
    await expect(dispatch(String(ana), "startLineCause", ["temp_task_lc1"])).rejects.toThrow(/still being filed/);
    const out = await dispatch(String(ana), "fileLineCause", ["lc1", String(project), FIELDS]);
    await expect(dispatch(String(ana), "startLineCause", [String(out.task_id)])).rejects.toThrow(/No role leads this project/);
  });
});
