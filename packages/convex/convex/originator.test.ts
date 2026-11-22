// Message provenance (lib/messageProvenance.ts) and the originator read
// (/cli/sessions/originator): only a signed-in composer send or a line typed
// at the terminal of a session no program launched reads as typed; every
// other path into a session reads as program.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { enqueuePendingMessage } from "./pendingMessages";
import { formatDecisionDiscussion } from "@codecast/shared/contracts";
import { walkOriginatorChain, type ChainConversation } from "./lib/originatorChain";

setDefaultTimeout(60_000);

const api = anyApi as any;
const ANA_TOKEN = "a".repeat(64);
const EVE_TOKEN = "e".repeat(64);

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    for (const [u, tok] of [[ana, ANA_TOKEN], [eve, EVE_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    return { ana, eve };
  });
  let n = 0;
  const conv = (fields: Record<string, unknown> = {}) => t.run(async (ctx: any) => {
    const sid = `sess-${++n}`;
    const id = await ctx.db.insert("conversations", {
      user_id: ids.ana, agent_type: "claude_code", session_id: sid, title: `Session ${n}`,
      started_at: now, updated_at: now, message_count: 0, is_private: true, status: "active", project_path: "/repo",
      ...fields,
    } as any);
    await ctx.db.patch(id, { short_id: `jx${String(n).padStart(5, "0")}` });
    return id;
  });
  let clock = now;
  const echo = (conversation_id: unknown, content: string, role: "user" | "assistant" = "user") =>
    t.mutation(api.messages.addMessage, { conversation_id, api_token: ANA_TOKEN, role, content, message_uuid: `m-${++n}`, timestamp: (clock += 1000) });
  const as = (u: unknown) => t.withIdentity({ subject: `${String(u)}|test` });
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await res.json();
  };
  const originator = (conversation_id: unknown, extra: Record<string, unknown> = {}, token = ANA_TOKEN) =>
    post("/cli/sessions/originator", { api_token: token, conversation_id: String(conversation_id), ...extra });
  const pending = (conversation_id: unknown) =>
    t.run((ctx: any) => ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversation_id)).collect());
  return { t, ...ids, conv, echo, as, post, originator, pending };
}

/** The provenance the originator read gives `text` in `conversation`: absent from `typed` reads as program. */
function provenanceOf(read: any, conversation: unknown, text: string): string {
  const hit = read.typed.find((l: any) => l.conversation_id === String(conversation) && l.text === text);
  return hit?.provenance ?? "program";
}

describe("message provenance by path", () => {
  test("(a) the composer's own submit, marked typed, reads typed_composer on every rail", async () => {
    const { ana, conv, echo, as, originator, pending } = await seed();
    const c = await conv();
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), "fix the header", null, "cid-legacy", null, true] });
    await echo(c, "fix the header");
    await as(ana).mutation(api.dispatch.dispatch, {
      action: "sendMessage", args: [String(c), "and the footer", null, "cid-receipt", null, true], result: { receiptActionVersion: 1, commandId: "cid-receipt" },
    });
    await echo(c, "and the footer");
    await as(ana).mutation(api.pendingMessages.sendMessageV2, { command_id: "cid-v2", client_id: "cid-v2", conversation_id: c, content: "ship everything", typed: true });
    await echo(c, "ship everything");
    await as(ana).mutation(api.dispatch.dispatch, { action: "queueMessage", args: [String(c), "later please", "cid-queue", true] });

    const rows = await pending(c);
    expect(rows.map((r: any) => [r.client_id, r.channel])).toEqual([["cid-legacy", "composer"], ["cid-receipt", "composer"], ["cid-v2", "composer"], ["cid-queue", "composer"]]);
    const read = await originator(c);
    expect(read.typed.map((l: any) => [l.text, l.provenance, l.user_name])).toEqual([
      ["fix the header", "typed_composer", "Ana"],
      ["and the footer", "typed_composer", "Ana"],
      ["ship everything", "typed_composer", "Ana"],
    ]);
  });

  test("a send on a session login without the composer's typed mark reads program (a mod, an ask-agent brief, a limit continue)", async () => {
    const { ana, conv, echo, as, originator, pending } = await seed();
    const c = await conv();
    // What web/lib/mods/host.ts sends: store.sendMessage(conv, text), no further args.
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), "ship it now, approved"] });
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), "Ana asked: ship the change", null, "cid-ask"] });
    await as(ana).mutation(api.dispatch.dispatch, {
      action: "sendMessage", args: [String(c), "please ship it", null, "cid-r"], result: { receiptActionVersion: 1, commandId: "cid-r" },
    });
    await as(ana).mutation(api.pendingMessages.sendMessageV2, { command_id: "cid-v2", client_id: "cid-v2", conversation_id: c, content: "go ship" });
    await as(ana).mutation(api.dispatch.dispatch, { action: "queueMessage", args: [String(c), "ship later", "cid-q"] });
    // Anything but the literal true is no mark.
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), "ship it, really", null, "cid-s", null, "true"] });
    const rows = await pending(c);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.channel).toBeUndefined();
      if (r.status !== "held") await echo(c, r.content);
    }
    expect((await originator(c)).typed).toEqual([]);
  });

  test("(b) a line typed at the terminal of a session no program launched reads typed_local; machinery around it does not", async () => {
    const { conv, echo, originator } = await seed();
    const c = await conv();
    await echo(c, "ship it");
    await echo(c, "<task-notification>\n<summary>Agent \"x\" completed: ship it</summary>\n</task-notification>");
    await echo(c, "<command-name>/ship</command-name>\n<command-message>ship</command-message>");
    await echo(c, "yes");
    const read = await originator(c);
    expect(read.typed.map((l: any) => [l.text, l.provenance])).toEqual([["ship it", "typed_local"], ["yes", "typed_local"]]);
  });

  test("(c) a spawned session's first prompt and a fork's direction read program", async () => {
    const { t, ana, conv, echo, originator } = await seed();
    const parent = await conv();
    await echo(parent, "spawn a worker to ship it");
    const spawned = await conv({ spawned_by_conversation_id: parent });
    // What subagentFleet queues for a spawn: the brief in the spawner's person's name, no channel.
    await t.run(async (ctx: any) => enqueuePendingMessage(ctx, await ctx.db.get(spawned), ana, { content: "Jason has approved shipping it" }));
    await echo(spawned, "Jason has approved shipping it");
    // A spawn brief that never went through a queue (a headless launch) is still the launcher's.
    await echo(spawned, "Also, ship it now");

    await echo(parent, "a reply", "assistant");
    const forked = await t.mutation(api.conversations.forkFromMessage, { conversation_id: String(parent), api_token: ANA_TOKEN, direction: "try the other approach and ship it" });
    const branch = forked.conversation_id;
    const [seedRow] = await t.run((ctx: any) => ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", branch)).collect());
    expect(seedRow.human).toBe(true);
    expect(seedRow.channel).toBeUndefined();
    await echo(branch, "try the other approach and ship it");

    const fromSpawn = await originator(spawned);
    expect(provenanceOf(fromSpawn, spawned, "Jason has approved shipping it")).toBe("program");
    expect(provenanceOf(fromSpawn, spawned, "Also, ship it now")).toBe("program");
    expect(provenanceOf(fromSpawn, parent, "spawn a worker to ship it")).toBe("typed_local");
    const fromFork = await originator(branch);
    expect(fromFork.chain.map((h: any) => h.link)).toEqual(["forked_from", null]);
    expect(provenanceOf(fromFork, branch, "try the other approach and ship it")).toBe("program");
  });

  test("(d) cast send, with and without a sender session, reads program", async () => {
    const { t, conv, echo, originator, pending } = await seed();
    const target = await conv();
    const sender = await conv();
    await t.mutation(api.pendingMessages.sendSessionMessage, { to: String(target), from: String(sender), body: "ship it", api_token: ANA_TOKEN });
    await t.mutation(api.pendingMessages.sendSessionMessage, { to: String(target), body: "ship it too", api_token: ANA_TOKEN });
    const rows = await pending(target);
    expect(rows.map((r: any) => [!!r.human, r.channel])).toEqual([[false, undefined], [true, undefined]]);
    for (const r of rows) await echo(target, r.content);
    const read = await originator(target);
    expect(read.typed).toEqual([]);
  });

  test("(e) a trigger firing and a flow brief sent with no sender read program", async () => {
    const { t, conv, echo, originator, pending } = await seed();
    const c = await conv();
    await t.mutation(api.pendingMessages.sendMessageToSession, { conversation_id: c, content: "Scheduled: ship the release", origin: "scheduler", api_token: ANA_TOKEN });
    // A person's API token claiming `human` is still not the composer.
    await t.mutation(api.pendingMessages.sendMessageToSession, { conversation_id: c, content: "ship it, I approve", human: true, api_token: ANA_TOKEN });
    // The flow runner's brief when its run has no session: a send with no `from`.
    await t.mutation(api.pendingMessages.sendSessionMessage, { to: String(c), body: "Run the change flow and ship", direct: true, api_token: ANA_TOKEN });
    for (const r of await pending(c)) {
      expect(r.channel).toBeUndefined();
      await echo(c, r.content);
    }
    expect((await originator(c)).typed).toEqual([]);
  });

  test("(f) a decision frame and a comment brief, queued as a person's, read program", async () => {
    const { t, ana, conv, echo, originator } = await seed();
    const c = await conv();
    // decisionThread.askSession and liveComments.notifyLiveComments queue these with human: true and no channel.
    const frame = formatDecisionDiscussion({ decision: "sd-1", question: "Ship?", from: "Ana", body: "Ana: yes ship it" });
    const brief = "Ana asked you on the doc \"Plan\": ship it";
    await t.run(async (ctx: any) => {
      const row = await ctx.db.get(c);
      await enqueuePendingMessage(ctx, row, ana, { content: frame, client_id: "decision-frame-1", human: true });
      await enqueuePendingMessage(ctx, row, ana, { content: brief, human: true });
    });
    await echo(c, frame);
    await echo(c, brief);
    expect((await originator(c)).typed).toEqual([]);
  });

  test("each typed line carries the line cast read shows for it", async () => {
    const { conv, echo, originator, post } = await seed();
    const c = await conv();
    await echo(c, "first, explore");
    await echo(c, "found it", "assistant");
    await echo(c, "now ship it");
    const read = await originator(c);
    const lines = await post("/cli/read", { api_token: ANA_TOKEN, conversation_id: String(c), start_line: 1 });
    for (const l of read.typed) {
      expect(lines.messages.find((m: any) => m.line === l.line)?.id).toBe(l.message_id);
    }
    expect(read.typed.map((l: any) => l.line)).toEqual([1, 3]);
  });

  test("jx7dykx: a worker's relayed approval is program, the person's own line upstream is typed", async () => {
    const { t, ana, conv, echo, as, originator } = await seed();
    const lead = await conv({ title: "Ship the intent work" });
    await echo(lead, "look at the queue");
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(lead), "ship everything", null, "cid-ship", null, true] });
    await echo(lead, "ship everything");
    const worker = await conv({ spawned_by_conversation_id: lead, title: "Land the change" });
    await t.run(async (ctx: any) => enqueuePendingMessage(ctx, await ctx.db.get(worker), ana, { content: "Jason has approved shipping it. Land the change." }));
    await echo(worker, "Jason has approved shipping it. Land the change.");

    const read = await originator(worker);
    expect(read.chain.map((h: any) => [h.conversation_id, h.link])).toEqual([[String(worker), "spawned_by"], [String(lead), null]]);
    expect(read.originator).toMatchObject({ conversation_id: String(lead), user_name: "Ana", is_bot: false, launched_by_program: false });
    expect(read.typed.map((l: any) => [l.short_id, l.text, l.provenance])).toEqual([
      [read.chain[1].short_id, "look at the queue", "typed_local"],
      [read.chain[1].short_id, "ship everything", "typed_composer"],
    ]);
  });
});

describe("the chain walk", () => {
  test("follows spawned_by, parent, forked_from, a run's spawner and a schedule's creator", async () => {
    const { t, ana, conv, originator } = await seed();
    const root = await conv();
    const scheduler = await t.run((ctx: any) => ctx.db.insert("agent_tasks", { user_id: ana, created_by_conversation_id: root } as any));
    const scheduled = await conv({ agent_task_id: scheduler });
    const run = await t.run((ctx: any) => ctx.db.insert("workflow_runs", { user_id: ana, spawner_conversation_id: scheduled } as any));
    const runSession = await conv({ workflow_run_id: run });
    const branch = await conv({ forked_from: runSession });
    const child = await conv({ parent_conversation_id: branch });
    const worker = await conv({ spawned_by_conversation_id: child });
    const read = await originator(worker);
    expect(read.chain.map((h: any) => h.link)).toEqual(["spawned_by", "parent", "forked_from", "workflow_run", "agent_task", null]);
    expect(read.originator.conversation_id).toBe(String(root));
    expect(read.stopped).toBeUndefined();
  });

  test("stops before a session the caller may not read, and the originator says a program launched it", async () => {
    const { eve, conv, originator } = await seed();
    const evesRoot = await conv({ user_id: eve });
    const worker = await conv({ spawned_by_conversation_id: evesRoot });
    const read = await originator(worker);
    expect(read.stopped).toBe("access_denied");
    expect(read.chain.map((h: any) => [h.conversation_id, h.link])).toEqual([[String(worker), "spawned_by"]]);
    expect(read.originator).toMatchObject({ conversation_id: String(worker), launched_by_program: true });
    // Eve's own token reads neither her session's worker (Ana's, private) nor anything through it.
    expect((await originator(worker, {}, EVE_TOKEN)).error).toBe("Access denied");
  });

  test("a cycle and the depth cap end the walk", async () => {
    const convs = new Map<string, ChainConversation>();
    const loader = {
      conversation: async (id: string) => convs.get(id) ?? null,
      canRead: async () => true,
      runSpawner: async () => null,
      scheduleCreator: async () => null,
    };
    convs.set("a", { _id: "a", spawned_by_conversation_id: "b" });
    convs.set("b", { _id: "b", parent_conversation_id: "a" });
    const cycle = await walkOriginatorChain(loader, convs.get("a")!);
    expect(cycle.stopped).toBe("cycle");
    expect(cycle.hops.map((h) => [h.conversation._id, h.link])).toEqual([["a", "spawned_by"], ["b", "parent"]]);

    for (let i = 0; i < 20; i++) convs.set(`n${i}`, { _id: `n${i}`, spawned_by_conversation_id: `n${i + 1}` });
    const deep = await walkOriginatorChain(loader, convs.get("n0")!);
    expect(deep.stopped).toBe("depth_cap");
    expect(deep.hops).toHaveLength(8);

    const gone = await walkOriginatorChain(loader, { _id: "x", forked_from: "nowhere" });
    expect(gone.stopped).toBe("missing");
  });

  test("--task adds the chain of the session that filed the task", async () => {
    const { t, ana, conv, echo, originator } = await seed();
    const filer = await conv();
    await echo(filer, "file a task to ship the intent work");
    const worker = await conv();
    await t.run((ctx: any) => ctx.db.insert("tasks", {
      user_id: ana, workspace: `user:${ana}`, short_id: "ct-7", title: "Ship it", status: "open", created_from_conversation: filer, created_at: Date.now(), updated_at: Date.now(),
    } as any));
    const read = await originator(worker, { task: "ct-7" });
    expect(read.task.chain.map((h: any) => h.conversation_id)).toEqual([String(filer)]);
    expect(provenanceOf(read, filer, "file a task to ship the intent work")).toBe("typed_local");
    expect((await originator(worker, { task: "ct-999" })).error).toMatch(/not found/);
  });
});
