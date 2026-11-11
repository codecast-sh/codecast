// Operator surfaces (daemon logs, daemon commands) answer only to `staff`.
// Team creation writes role "admin" onto the creator's user row, so a gate on
// users.role made every team founder a platform operator.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./teams.ts": () => import("./teams"),
  "./users.ts": () => import("./users"),
  "./daemonLogs.ts": () => import("./daemonLogs"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./teamActivity.ts": () => import("./teamActivity"),
  "./authorityEvents.ts": () => import("./authorityEvents"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    founder: await ctx.db.insert("users", { email: "f@x", name: "Founder" } as any),
    operator: await ctx.db.insert("users", { email: "o@x", name: "Operator", staff: true } as any),
  }));
  const as = (id: string) => t.withIdentity({ subject: `${id}|x` } as any);
  return { t, ids, as };
}

describe("staff gate", () => {
  test("a team founder gets no operator access", async () => {
    const { t, ids, as } = await setup();
    await as(ids.founder).mutation(api.teams.createTeam, { name: "Mine" } as any);
    const founder = await t.run((ctx) => ctx.db.get(ids.founder));
    expect(founder?.role).toBe("admin");

    expect((await as(ids.founder).query(api.daemonLogs.adminList, {})).isAdmin).toBe(false);
    expect(await as(ids.founder).query(api.daemonLogs.adminGetUsers, {})).toEqual([]);
    expect(await as(ids.founder).query(api.daemonLogs.adminGetStats, {})).toBeNull();
    expect(await as(ids.founder).query(api.users.getPendingCommands, { user_id: ids.operator })).toEqual([]);
    await expect(
      as(ids.founder).mutation(api.users.sendDaemonCommand, { user_id: ids.operator, command: "restart" }),
    ).rejects.toThrow("Not authorized");
  });

  test("staff maintenance commands reach another user's daemon, each with an audit row", async () => {
    const { t, ids, as } = await setup();
    const { command_id } = await as(ids.operator).mutation(api.users.sendDaemonCommand, { user_id: ids.founder, command: "restart" });
    const row = await t.run((ctx) => ctx.db.get(command_id));
    expect(row).toMatchObject({ user_id: ids.founder, command: "restart" });
    expect(row?.args).toBeUndefined();
    const audit = await t.run((ctx) => ctx.db.query("authority_events").collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "staff_daemon_command", actor_user_id: ids.operator, target_user_id: ids.founder });
    expect(audit[0].detail.after).toMatchObject({ command: "restart", command_id });
  });

  test("staff cannot run code, type into panes or touch config on another user's machine", async () => {
    const { t, ids, as } = await setup();
    for (const command of ["config_write", "config_create", "config_read", "send_keys", "start_session", "resume_session", "run_workflow", "kill_session"]) {
      await expect(
        as(ids.operator).mutation(api.users.sendDaemonCommand, { user_id: ids.founder, command, args_json: "{}" } as any),
      ).rejects.toThrow();
    }
    await expect(
      as(ids.operator).mutation(api.users.sendDaemonCommand, { user_id: ids.founder, command: "restart", args_json: "{}" } as any),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("daemon_commands").collect())).toEqual([]);
  });

  test("a fleet command leaves one audit row naming the verb and how many daemons it reached", async () => {
    const { t, ids, as } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.founder, { last_heartbeat: Date.now() } as any));
    const { sent } = await as(ids.operator).mutation(api.users.sendDaemonCommandToAll, { command: "force_update" });
    expect(sent).toBe(1);
    const audit = await t.run((ctx) => ctx.db.query("authority_events").collect());
    expect(audit).toHaveLength(1);
    expect(audit[0].detail.after).toMatchObject({ command: "force_update", fleet: true, sent: 1 });
  });

  test("staff reads the operator views", async () => {
    const { ids, as } = await setup();
    expect((await as(ids.operator).query(api.daemonLogs.adminList, {})).isAdmin).toBe(true);
    expect(await as(ids.operator).query(api.daemonLogs.adminGetStats, {})).not.toBeNull();
  });
});

describe("errorShape", () => {
  test("folds per-user paths, ids and counts into one error", async () => {
    const { errorShape } = await import("./daemonLogs");
    const a = errorShape("Cursor transcript event failed (/Users/deep/.cursor/a.jsonl): 12 retries");
    const b = errorShape("Cursor transcript event failed (/Users/kris/.cursor/b.jsonl): 3 retries");
    expect(a).toBe(b);
    expect(a).toBe("Cursor transcript event failed (<path>): N retries");
    expect(errorShape("Session e0ee76ff1a missing")).toBe("Session <id> missing");
  });
});
