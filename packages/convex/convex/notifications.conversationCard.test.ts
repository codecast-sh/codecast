import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { list } from "./notifications";
import { makeSessionStartsDb } from "./lib/sessionStarts";

// notifications.list names each row's session through the session_starts
// card, never the conversation: a streamed message patches the conversation
// several times a second, and a list that read it re-ran for every subscriber
// on each one (ct-92571).

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    const db = makeSessionStartsDb(ctx.db, ctx.db);
    const conv = await db.insert("conversations", {
      user_id: me, is_private: true, agent_type: "claude_code", started_at: 1_000, status: "active",
      message_count: 3, updated_at: 1_000, title: "Fix auth", project_path: "/src/app", character_name: "Wren",
    } as any);
    await ctx.db.insert("notifications", {
      recipient_user_id: me, type: "session_idle", conversation_id: conv, message: "done", read: false, created_at: 2_000,
    } as any);
    return { me, conv };
  });
  return { t, ...ids };
}

async function listAs(t: any, me: any, onGet?: (id: string) => void) {
  return await t.run(async (ctx: any) => {
    const get = ctx.db.get.bind(ctx.db);
    const db = { ...ctx.db, query: ctx.db.query.bind(ctx.db), get: (id: any) => { onGet?.(String(id)); return get(id); } };
    return await (list as any)._handler({ ...ctx, db, auth: { getUserIdentity: async () => ({ subject: `${me}|s` }) } }, {});
  });
}

describe("notifications.list reads the session card, not the conversation", () => {
  test("the row names its session from the card and never gets the conversation", async () => {
    const { t, me, conv } = await setup();
    const gets: string[] = [];
    const [row] = await listAs(t, me, (id) => gets.push(id));
    expect(row.conversation).toMatchObject({ _id: conv, title: "Fix auth", project_path: "/src/app", agent_type: "claude_code", character_name: "Wren", character_avatar: null });
    expect(gets).not.toContain(String(conv));
  });

  test("a rename reaches the card; a streamed message leaves it alone", async () => {
    const { t, me, conv } = await setup();
    const card = () => t.run(async (ctx) => (await ctx.db.query("session_starts").first())!);
    const before = await card();
    await t.run(async (ctx) => makeSessionStartsDb(ctx.db, ctx.db).patch(conv, { message_count: 4, updated_at: 3_000, last_message_role: "assistant" } as any));
    expect((await card())._creationTime).toBe(before._creationTime);
    expect((await card()).card).toEqual(before.card);
    await t.run(async (ctx) => makeSessionStartsDb(ctx.db, ctx.db).patch(conv, { title: "Fix auth flow" } as any));
    const [row] = await listAs(t, me);
    expect(row.conversation.title).toBe("Fix auth flow");
  });

  test("a row written before the card existed falls back to the conversation", async () => {
    const { t, me, conv } = await setup();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("session_starts").first())!;
      const { card: _drop, _id, _creationTime, ...rest } = row as any;
      await ctx.db.replace(_id, rest);
    });
    const gets: string[] = [];
    const [row] = await listAs(t, me, (id) => gets.push(id));
    expect(row.conversation.title).toBe("Fix auth");
    expect(gets).toContain(String(conv));
  });
});
