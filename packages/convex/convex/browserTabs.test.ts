// A device's browser tab report is its whole set: named sessions get rows,
// linked to the caller's own conversation; a session it stops naming loses its row.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

const TOKEN = "b".repeat(64);
const T0 = Date.now();
const tab = (id: string, title = `Page ${id}`) => ({ id, title, url: `https://example.com/${id}`, where: "chrome" as const });

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const stranger = await ctx.db.insert("users", { name: "Ben" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const conv = (owner: any, session: string) => ctx.db.insert("conversations", {
      user_id: owner, session_id: session, agent_type: "claude_code", status: "active", started_at: T0, updated_at: T0, message_count: 1,
    } as any);
    return { user, mine: await conv(user, "s-mine"), theirs: await conv(stranger, "s-theirs") };
  });
  const report = (device: string, sessions: Array<{ session_id: string; tabs: ReturnType<typeof tab>[]; last_used_at?: number }>) =>
    t.mutation(api.browserTabs.report, { api_token: TOKEN, device_id: device, sessions: sessions.map((s) => ({ last_used_at: T0, ...s })) });
  const rows = () => t.run((ctx) => ctx.db.query("session_browser_tabs").collect()) as Promise<any[]>;
  const list = () => t.withIdentity({ subject: `${ids.user}|s` }).query(api.browserTabs.webList, {});
  return { ids, report, rows, list };
}

describe("browserTabs.report", () => {
  test("links the caller's own conversation and lists it for the viewer", async () => {
    const { ids, report, list } = await setup();
    await report("laptop", [{ session_id: "s-mine", tabs: [tab("1", "Inbox")] }]);
    const listed = await list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ conversation_id: ids.mine, tabs: [{ id: "1", title: "Inbox" }] });
  });

  test("never links another user's conversation", async () => {
    const { report, rows, list } = await setup();
    await report("laptop", [{ session_id: "s-theirs", tabs: [tab("1")] }]);
    expect((await rows())[0].conversation_id).toBeUndefined();
    expect(await list()).toEqual([]);
  });

  test("a session the device stops naming loses its row; another device's rows stay", async () => {
    const { report, rows } = await setup();
    await report("laptop", [{ session_id: "s-mine", tabs: [tab("1")] }]);
    await report("desktop", [{ session_id: "s-other", tabs: [tab("2")] }]);
    await report("laptop", []);
    expect((await rows()).map((r) => r.session_id)).toEqual(["s-other"]);
  });

  test("an unchanged report writes nothing; a changed title does", async () => {
    const { report, rows } = await setup();
    await report("laptop", [{ session_id: "s-mine", tabs: [tab("1")] }]);
    const first = (await rows())[0];
    await report("laptop", [{ session_id: "s-mine", tabs: [tab("1")] }]);
    expect((await rows())[0]._creationTime).toBe(first._creationTime);
    expect((await rows())[0].reported_at).toBe(first.reported_at);
    await report("laptop", [{ session_id: "s-mine", tabs: [tab("1", "Renamed")] }]);
    expect((await rows())[0].tabs[0].title).toBe("Renamed");
  });
});
