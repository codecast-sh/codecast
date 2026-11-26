// A decision whose session a person closed leaves every queue, but
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
  return { t, ana, conv, id: asked.id as string, queue, cliMine, convRow, patchConv };
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
  expect(row?.asker_ended).toBe(true);
  expect(await cliMine()).not.toContain(id);

  // Un-hidden (the dismissed stamp cleared), the session is open again and so is its decision's place in the queue.
  await patchConv({ inbox_dismissed_at: undefined });
  expect((await queue())[0]).toMatchObject({ in_queue: true });
  expect((await queue())[0]?.asker_ended).toBeUndefined();
});

test("a killed session's open decision stays in the queue: a run's station is killed when it ends, its card still waiting", async () => {
  const { queue, cliMine, id, patchConv } = await seed();
  const at = Date.now();
  // A kill may also stamp the close (cleanup.ts); isClosedSession reads a killed row as not closed.
  await patchConv({ inbox_killed_at: at, inbox_dismissed_at: at, inbox_closed_at: at });
  expect((await queue())[0]?.in_queue).toBe(true);
  expect(await cliMine()).toContain(id);
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

test("a run's decision stays in the queue when the session it was asked from is closed: the run waits on it", async () => {
  const { t, id, queue, cliMine, patchConv } = await seed();
  await t.run(async (ctx: any) => {
    const run = await ctx.db.insert("workflow_runs", { user_id: (await ctx.db.get(id as any)).user_id, workflow_name: "change", status: "paused", node_statuses: [], created_at: 1, updated_at: 1 } as any);
    await ctx.db.patch(id as any, { workflow_run_id: run });
  });
  const at = Date.now();
  await patchConv({ inbox_dismissed_at: at, inbox_closed_at: at });
  expect((await queue())[0]?.in_queue).toBe(true);
  expect(await cliMine()).toContain(id);
});

test("someone else closing their session leaves the question in this person's queue", async () => {
  const { t, queue, patchConv } = await seed();
  const other = await t.run((ctx: any) => ctx.db.insert("users", { name: "Bo" } as any));
  const at = Date.now();
  await patchConv({ user_id: other, inbox_dismissed_at: at, inbox_closed_at: at });
  expect((await queue())[0]?.in_queue).toBe(true);
});

test("a team session is closed by each person's own triage, never by the row", async () => {
  const { t, ana, conv, queue } = await seed();
  const at = Date.now();
  await t.run(async (ctx: any) => {
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: at } as any);
    await ctx.db.patch(conv, { team_owner_team_id: team });
    await ctx.db.insert("session_team_owners", { conversation_id: conv, team_id: team, added_by: ana, added_at: at });
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "member", joined_at: at, visibility: "full" } as any);
  });
  // The row's own Close (from before it became a team session) is not this person's: their inbox shows it open.
  await t.run((ctx: any) => ctx.db.patch(conv, { inbox_dismissed_at: at, inbox_closed_at: at }));
  expect((await queue())[0]?.in_queue).toBe(true);
  // This person's own Close of the team session takes it out of their queue.
  await t.run((ctx: any) => ctx.db.insert("session_viewer_triage", { user_id: ana, conversation_id: conv, inbox_dismissed_at: at, inbox_closed_at: at, updated_at: at } as any));
  expect((await queue())[0]?.in_queue).toBe(false);
});

test("a co-owner's Close of the session reads as closed for every owner, as the inbox does", async () => {
  const { t, ana, conv, queue, patchConv } = await seed();
  const bo = await t.run(async (ctx: any) => {
    const bo = await ctx.db.insert("users", { name: "Bo" } as any);
    await ctx.db.insert("session_owners", { conversation_id: conv, user_id: bo, added_by: ana, added_at: Date.now() });
    return bo;
  });
  expect(bo).toBeTruthy();
  const at = Date.now();
  await patchConv({ inbox_dismissed_at: at, inbox_closed_at: at });
  expect((await queue())[0]?.in_queue).toBe(false);
});

test("a card the server set down in a session stays in the queue when that session is closed", async () => {
  const { t, id, queue, patchConv } = await seed();
  const at = Date.now();
  await patchConv({ inbox_dismissed_at: at, inbox_closed_at: at });
  expect((await queue())[0]?.in_queue).toBe(false);
  // A merge approval card is posted into the holder's latest session and waits on them whatever became of it.
  await t.run((ctx: any) => ctx.db.patch(id as any, { approval_card: true }));
  expect((await queue())[0]?.in_queue).toBe(true);
});
