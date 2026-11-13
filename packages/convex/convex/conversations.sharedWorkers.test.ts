// A shared parent's page names and opens its shared workers: a share-link
// viewer resolves a worker reference through the parent it is drawn in, and
// gets the worker's own link only when the owner shared that worker too.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

const PARENT_TOKEN = "11111111-1111-4111-8111-111111111111";
const CHILD_TOKEN = "22222222-2222-4222-9222-222222222222";

async function setup(child: { share_token?: string; link?: "parent" | "spawned_by" | "none" } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ada", email: "ada@x.dev" } as any);
    const stranger = await ctx.db.insert("users", { name: "Mo", email: "mo@x.dev" } as any);
    const base = { user_id: owner, agent_type: "claude_code", started_at: 1, updated_at: 1, message_count: 0, is_private: true, status: "active" };
    const parent = await ctx.db.insert("conversations", { ...base, session_id: crypto.randomUUID(), title: "Parent", share_token: PARENT_TOKEN } as any);
    const link = child.link ?? "parent";
    const worker = await ctx.db.insert("conversations", {
      ...base,
      session_id: crypto.randomUUID(),
      title: "Pandora research",
      ...(child.share_token ? { share_token: child.share_token } : {}),
      ...(link === "parent" ? { parent_conversation_id: parent, is_subagent: true } : link === "spawned_by" ? { spawned_by_conversation_id: parent } : {}),
    } as any);
    await ctx.db.patch(worker, { short_id: String(worker).slice(0, 7) } as any);
    return { owner, stranger, parent, worker };
  });
  return { t, ...ids };
}

const scoped = (parent: Id<"conversations">, token?: string) => ({ in_conversation: String(parent), ...(token ? { share_token: token } : {}) });

describe("webGet for a shared parent's workers", () => {
  test("a guest holding the parent's link names the shared worker and gets its link", async () => {
    const { t, parent, worker } = await setup({ share_token: CHILD_TOKEN });
    const row = await t.query(api.conversations.webGet, { short_id: String(worker).slice(0, 7), ...scoped(parent, PARENT_TOKEN) });
    expect(row?.title).toBe("Pandora research");
    expect(row?.share_token).toBe(CHILD_TOKEN);
    const byId = await t.query(api.conversations.webGet, { id: String(worker), ...scoped(parent, PARENT_TOKEN) });
    expect(byId?._id).toBe(worker);
  });

  test("a worker linked by spawned_by resolves the same way", async () => {
    const { t, parent, worker } = await setup({ share_token: CHILD_TOKEN, link: "spawned_by" });
    const row = await t.query(api.conversations.webGet, { id: String(worker), ...scoped(parent, PARENT_TOKEN) });
    expect(row?.share_token).toBe(CHILD_TOKEN);
  });

  test("an unshared worker stays private", async () => {
    const { t, parent, worker } = await setup();
    expect(await t.query(api.conversations.webGet, { id: String(worker), ...scoped(parent, PARENT_TOKEN) })).toBeNull();
  });

  test("without the parent's link, or with a wrong one, nothing resolves", async () => {
    const { t, parent, worker, stranger } = await setup({ share_token: CHILD_TOKEN });
    expect(await t.query(api.conversations.webGet, { id: String(worker), ...scoped(parent) })).toBeNull();
    expect(await t.query(api.conversations.webGet, { id: String(worker), ...scoped(parent, CHILD_TOKEN) })).toBeNull();
    const asStranger = t.withIdentity({ subject: `${stranger}|session` });
    expect(await asStranger.query(api.conversations.webGet, { id: String(worker), ...scoped(parent) })).toBeNull();
  });

  test("a session the scope did not spawn is not reachable through it", async () => {
    const { t, parent, worker } = await setup({ share_token: CHILD_TOKEN, link: "none" });
    expect(await t.query(api.conversations.webGet, { id: String(worker), ...scoped(parent, PARENT_TOKEN) })).toBeNull();
  });

  test("the owner still gets the full row and no link", async () => {
    const { t, parent, worker, owner } = await setup({ share_token: CHILD_TOKEN });
    const row = await t.withIdentity({ subject: `${owner}|session` }).query(api.conversations.webGet, { id: String(worker) });
    expect(row?.is_own).toBe(true);
    expect(row?.share_token).toBeUndefined();
    void parent;
  });
});
