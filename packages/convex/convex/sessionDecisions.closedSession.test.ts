// A decision whose session a person closed (or killed) leaves every queue, but
// stays answerable from its own page; the answer enters the session as a
// person's message, which reopens it, and its other decisions return.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { isClosedSession } from "@codecast/shared/contracts";

setDefaultTimeout(60_000);

const api = anyApi as any;
const TOKEN = "c".repeat(64);
const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const { ana, conv } = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: ana, agent_type: "claude_code", session_id: "sess-1", short_id: "jx7cls1", title: "Pricing",
      started_at: now, updated_at: now, message_count: 3, is_private: true, status: "active", project_path: "/repo",
    } as any);
    return { ana, conv };
  });
  const asked = await t.mutation(api.sessionDecisions.ask, {
    api_token: TOKEN, session_id: "sess-1", question: "Raise the price?",
    options: [{ label: "Raise", description: "x" }, { label: "Keep", description: "y" }],
  });
  expect(asked.error).toBeUndefined();
  const queue = async () => (await t.withIdentity({ subject: `${String(ana)}|test` }).query(api.sessionDecisions.listForUser, {})).filter((d: any) => String(d._id) === asked.id);
  const cliMine = async () => ((await t.mutation(api.sessionDecisions.listForSession, { api_token: TOKEN, mine: true })).decisions ?? []).map((d: any) => String(d.id ?? d._id));
  const convRow = (): Promise<any> => t.run((ctx: any) => ctx.db.get(conv));
  const patchConv = (p: Record<string, unknown>) => t.run((ctx: any) => ctx.db.patch(conv, p));
  return { t, id: asked.id as string, queue, cliMine, convRow, patchConv };
}

test("a closed session's open decision leaves the queue and the CLI list, but is still sent to the page's collection", async () => {
  const { id, queue, cliMine, patchConv } = await seed();
  expect((await queue())[0]?.in_queue).toBe(true);
  expect(await cliMine()).toContain(id);

  const at = Date.now();
  await patchConv({ inbox_dismissed_at: at, inbox_closed_at: at });
  const [row] = await queue();
  expect(row?.status).toBe("pending");
  expect(row?.in_queue).toBe(false);
  expect(await cliMine()).not.toContain(id);

  // Un-hidden (the dismissed stamp cleared), the session is open again and so is its decision's place in the queue.
  await patchConv({ inbox_dismissed_at: undefined });
  expect((await queue())[0]?.in_queue).toBe(true);
});

test("a killed session's open decision leaves the queue too", async () => {
  const { queue, patchConv } = await seed();
  await patchConv({ inbox_killed_at: Date.now(), inbox_dismissed_at: Date.now() });
  expect((await queue())[0]?.in_queue).toBe(false);
});

test("answering a closed session's decision reopens the session", async () => {
  const { t, id, convRow, patchConv } = await seed();
  const at = Date.now();
  await patchConv({ inbox_dismissed_at: at, inbox_closed_at: at });
  expect(isClosedSession(await convRow())).toBe(true);

  const res = await t.mutation(api.sessionDecisions.answer, { api_token: TOKEN, decision_id: id, answer_index: 0 });
  expect(res.error).toBeUndefined();
  const after = await convRow();
  expect(isClosedSession(after)).toBe(false);
  expect(after.has_pending_messages).toBe(true);
});
