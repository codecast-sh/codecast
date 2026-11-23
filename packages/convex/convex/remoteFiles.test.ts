// A file link opened on another machine asks the conversation's own machine
// for the file: only the owner's device is asked, and the answer is scrubbed
// from the row afterwards.
import { describe, expect, setDefaultTimeout, test, vi } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { READ_FILE_SCRUB_MS } from "./remoteFiles";

setDefaultTimeout(120_000);

async function setup() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const other = await ctx.db.insert("users", { name: "Bo", email: "bo@x.dev" } as any);
    await ctx.db.insert("devices", { user_id: owner, device_id: "there", last_seen: now, label: "MacBook-Pro-182" } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
      message_count: 0, is_private: true, status: "active", owner_device_id: "there", project_path: "/Users/ann/src/family",
    } as any);
    const homeless = await ctx.db.insert("conversations", {
      user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
      message_count: 0, is_private: true, status: "active",
    } as any);
    return { owner, other, conv, homeless };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

describe("remoteFiles.request", () => {
  test("queues read_file on the conversation's machine and names it", async () => {
    const { t, owner, conv, as } = await setup();
    const path = "/Users/ann/src/family/x-growth/daily/2026-11-12.md";
    const res = await as(owner).mutation(api.remoteFiles.request, { conversation_id: conv, path });
    if (!res.ok) throw new Error(res.reason);
    expect(res.machine).toBe("MacBook-Pro-182");
    const cmd = await t.run((ctx) => ctx.db.get(res.command_id));
    expect(cmd).toMatchObject({ command: "read_file", target_device_id: "there", user_id: owner });
    expect(JSON.parse(cmd!.args!)).toEqual({ path });
  });

  test("someone without access to the conversation queues nothing", async () => {
    const { t, other, conv, as } = await setup();
    const res = await as(other).mutation(api.remoteFiles.request, { conversation_id: conv, path: "/etc/hosts" });
    expect(res.ok).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("daemon_commands").collect())).toHaveLength(0);
  });

  test("a conversation with no machine, or a relative path, queues nothing", async () => {
    const { t, owner, conv, homeless, as } = await setup();
    expect(await as(owner).mutation(api.remoteFiles.request, { conversation_id: homeless, path: "/x.md" })).toMatchObject({ ok: false, reason: "no_machine" });
    expect(await as(owner).mutation(api.remoteFiles.request, { conversation_id: conv, path: "x.md" })).toMatchObject({ ok: false, reason: "bad_path" });
    expect(await t.run((ctx) => ctx.db.query("daemon_commands").collect())).toHaveLength(0);
  });

  test("the file's text is scrubbed from the row after the window", async () => {
    vi.useFakeTimers();
    try {
      const { t, owner, conv, as } = await setup();
      const res = await as(owner).mutation(api.remoteFiles.request, { conversation_id: conv, path: "/Users/ann/src/family/a.md" });
      if (!res.ok) throw new Error(res.reason);
      await t.run((ctx) => ctx.db.patch(res.command_id, { executed_at: Date.now(), result: JSON.stringify({ exists: true, content: "secret-ish" }) }));
      vi.advanceTimersByTime(READ_FILE_SCRUB_MS + 1);
      await t.finishInProgressScheduledFunctions();
      const row = await t.run((ctx) => ctx.db.get(res.command_id));
      expect(row?.result).toBeUndefined();
      expect(row?.executed_at).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
