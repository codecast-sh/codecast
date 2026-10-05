// /line/settings edits a project's line file through dispatch's
// editLineProfile (plan pl-838): it queues line_profile_edit for the daemon on
// the machine that published the profile, with the checkout the row names and
// the store's request id (which the sessionCommands feed settles by),
// and refuses (a permanent refusal, so the web takes its paint back) when the
// row names no machine, the machine is not the viewer's, or the viewer cannot
// see the project.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";

const api = anyApi as any;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./dispatch.ts": () => import("./dispatch"),
  "./users.ts": () => import("./users"),
};

const EDITS = [{ op: "set", key: "commands.check", value: "bun test" }];

async function seed(profile: Record<string, unknown> | null) {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    await ctx.db.insert("devices", { user_id: ana, device_id: "ana-mac", label: "Ana's Mac", platform: "darwin", last_seen: now } as any);
    await ctx.db.insert("devices", { user_id: eve, device_id: "eve-mac", label: "Eve's Mac", platform: "darwin", last_seen: now } as any);
    const project = await ctx.db.insert("projects", {
      user_id: ana, workspace: `user:${ana}`, title: "Codecast", status: "active", created_at: now, updated_at: now,
      ...(profile ? { line_profile: { finders: [], changed_at: now, ...profile } } : {}),
    } as any);
    return { ana, eve, project };
  });
  const dispatch = (u: string, args: unknown[]) => t.withIdentity({ subject: `${u}|test` }).mutation(api.dispatch.dispatch, { action: "editLineProfile", args });
  return { t, ...ids, dispatch };
}

describe("editLineProfile", () => {
  test("queues the edit for the publishing machine, at the checkout the row names", async () => {
    const { t, ana, project, dispatch } = await seed({ root: "/src/codecast", device_id: "ana-mac" });
    const out = await dispatch(String(ana), ["req-1", String(project), EDITS]);
    const cmd = await t.run((ctx) => ctx.db.get(out.command_id));
    expect(cmd).toMatchObject({ command: "line_profile_edit", target_device_id: "ana-mac", user_id: ana });
    expect(JSON.parse((cmd as any).args)).toEqual({ root: "/src/codecast", edits: EDITS });
    expect((cmd as any).request_id).toBe("req-1");
  });

  test("an outbox retry of the same request answers the command already queued", async () => {
    const { t, ana, project, dispatch } = await seed({ root: "/src/codecast", device_id: "ana-mac" });
    const a = await dispatch(String(ana), ["req-1", String(project), EDITS]);
    const b = await dispatch(String(ana), ["req-1", String(project), EDITS]);
    expect(b.command_id).toBe(a.command_id);
    const all = await t.run((ctx) => ctx.db.query("daemon_commands").collect());
    expect(all).toHaveLength(1);
  });

  test("refuses a row no current cast has published (no machine to send to)", async () => {
    const { ana, project, dispatch } = await seed({ root: "/src/codecast" });
    await expect(dispatch(String(ana), ["req-1", String(project), EDITS])).rejects.toThrow(/No machine has published/);
  });

  test("refuses when the checkout is on another person's machine", async () => {
    const { ana, project, dispatch } = await seed({ root: "/src/codecast", device_id: "eve-mac" });
    await expect(dispatch(String(ana), ["req-1", String(project), EDITS])).rejects.toThrow(/not yours/);
  });

  test("refuses when the row says someone else published it, even naming the viewer's own machine", async () => {
    const { ana, project, dispatch } = await seed({ root: "/src/elsewhere", device_id: "ana-mac", publisher_user_id: "someone-else" });
    await expect(dispatch(String(ana), ["req-1", String(project), EDITS])).rejects.toThrow(/teammate's machine/);
  });

  test("refuses a viewer who cannot see the project, and an empty edit", async () => {
    const { ana, eve, project, dispatch } = await seed({ root: "/src/codecast", device_id: "eve-mac" });
    await expect(dispatch(String(eve), ["req-1", String(project), EDITS])).rejects.toThrow(/Project not found/);
    await expect(dispatch(String(ana), ["req-2", String(project), []])).rejects.toThrow(/one to fifty/);
  });
});
