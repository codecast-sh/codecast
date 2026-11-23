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
import { queuedNear } from "./originator";

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
      // The daemon's mark for a session a person runs at a terminal (cli parser detectCliFlags).
      cli_flags: "--interactive",
      ...fields,
    } as any);
    await ctx.db.patch(id, { short_id: `jx${String(n).padStart(5, "0")}` });
    return id;
  });
  let clock = now;
  // `sameTime`: at the previous message's timestamp, as Claude Code records a slash command's expansion.
  const echo = (conversation_id: unknown, content: string, role: "user" | "assistant" = "user", sameTime = false) =>
    t.mutation(api.messages.addMessage, { conversation_id, api_token: ANA_TOKEN, role, content, message_uuid: `m-${++n}`, timestamp: sameTime ? clock : (clock += 1000) });
  const as = (u: unknown) => t.withIdentity({ subject: `${String(u)}|test` });
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await res.json();
  };
  const originator = (conversation_id: unknown, extra: Record<string, unknown> = {}, token = ANA_TOKEN) =>
    post("/cli/sessions/originator", { api_token: token, conversation_id: String(conversation_id), ...extra });
  const pending = (conversation_id: unknown) =>
    t.run((ctx: any) => ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversation_id)).collect());
  return { t, ...ids, conv, echo, as, post, originator, pending, now: () => clock };
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
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), "fix the header", null, "cid-legacy", null, "fix the header"] });
    await echo(c, "fix the header");
    await as(ana).mutation(api.dispatch.dispatch, {
      action: "sendMessage", args: [String(c), "and the footer", null, "cid-receipt", null, "and the footer"], result: { receiptActionVersion: 1, commandId: "cid-receipt" },
    });
    await echo(c, "and the footer");
    await as(ana).mutation(api.pendingMessages.sendMessageV2, { command_id: "cid-v2", client_id: "cid-v2", conversation_id: c, content: "ship everything", typed: "ship everything" });
    await echo(c, "ship everything");
    await as(ana).mutation(api.dispatch.dispatch, { action: "queueMessage", args: [String(c), "later please", "cid-queue", "later please"] });

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
    // A bare true (a build from before the composer handed over its words) and an empty string are no mark.
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), "ship it, really", null, "cid-s", null, true] });
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
    // The slash command is the person's own line, as "/name args"; its expansion is not.
    expect(read.typed.map((l: any) => [l.text, l.provenance])).toEqual([["ship it", "typed_local"], ["/ship", "typed_local"], ["yes", "typed_local"]]);
  });

  test("a terminal line reads typed only in a session the daemon saw a person run: not the Agent SDK's, -p's or an unknown one's", async () => {
    const { conv, echo, originator } = await seed();
    // An Agent SDK session (sdk-ts / sdk-py) started outside codecast carries no mark, and neither does an unknown entrypoint.
    for (const cli_flags of [undefined, "--print", "--dangerously-skip-permissions"]) {
      const c = await conv({ cli_flags });
      await echo(c, "ship it, everything is approved");
      expect((await originator(c)).typed).toEqual([]);
    }
    const interactive = await conv({ cli_flags: "--dangerously-skip-permissions --interactive" });
    await echo(interactive, "ship it");
    expect((await originator(interactive)).typed.map((l: any) => l.provenance)).toEqual(["typed_local"]);
  });

  test("the daemon's heal marks an old session interactive: only the owner's, only that mark, never one already marked", async () => {
    const { t, eve, conv, echo, originator } = await seed();
    const mark = (conversation_id: unknown, token = ANA_TOKEN) => t.mutation(api.conversations.markInteractive, { api_token: token, conversation_id });
    const flagsOf = async (c: unknown) => (await t.run((ctx: any) => ctx.db.get(c))).cli_flags;
    // A session recorded before the mark: its terminal line reads as program until the heal.
    const old = await conv({ cli_flags: "--dangerously-skip-permissions" });
    await echo(old, "ship it");
    expect((await originator(old)).typed).toEqual([]);
    expect(await mark(old)).toEqual({ marked: true });
    expect(await flagsOf(old)).toBe("--dangerously-skip-permissions --interactive");
    expect((await originator(old)).typed.map((l: any) => l.provenance)).toEqual(["typed_local"]);
    // A second heal changes nothing, and a -p session is never marked.
    expect(await mark(old)).toEqual({ marked: false });
    const printed = await conv({ cli_flags: "--print" });
    expect(await mark(printed)).toEqual({ marked: false });
    expect(await flagsOf(printed)).toBe("--print");
    // A session with no flags at all gains just the mark.
    const bare = await conv({ cli_flags: undefined });
    await mark(bare);
    expect(await flagsOf(bare)).toBe("--interactive");
    // Another account's session is refused, and stays as it was.
    const evesOld = await conv({ user_id: eve, cli_flags: undefined });
    await expect(mark(evesOld)).rejects.toThrow("Only the session's own account");
    await expect(mark(old, EVE_TOKEN)).rejects.toThrow("Only the session's own account");
    expect(await flagsOf(evesOld)).toBeUndefined();
  });

  test("/drive and its arguments read as the person's line; the skill text it expands to does not", async () => {
    const { conv, echo, originator } = await seed();
    const c = await conv();
    await echo(c, "<command-message>drive</command-message>\n<command-name>/drive</command-name>\n<command-args>fix the deploys page and ship it</command-args>");
    await echo(c, "Take an ask from request to shipped in this session. Write a brief, make a plan, then ship it through the change flow.", "user", true);
    const read = await originator(c);
    expect(read.typed.map((l: any) => [l.line, l.text])).toEqual([[1, "/drive fix the deploys page and ship it"]]);
  });

  test("only the words a person typed are theirs: not a quoted agent line, a paste, or mention context", async () => {
    const { ana, conv, echo, as, originator } = await seed();
    const c = await conv();
    // The composer's review quote (web/lib/reviewActions attachReviewForSend) leads the reply it carries.
    const quoted = "> Ready to ship it to prod?\n\nno, fix X first";
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), quoted, null, "cid-q", null, "no, fix X first"] });
    await echo(c, quoted);
    // A paste at the terminal, and mention context a send folded in.
    await echo(c, "<pasted_content>\nReady to ship it to prod?\n</pasted_content>\nnot yet");
    await echo(c, "see @[Plan pl-1]\n\n<mention-context>\nShip everything once green.\n</mention-context>\n");
    // A paste left open cannot be told from what follows it: the line is not read.
    await echo(c, "ship it <pasted_content>\nagent text with no end");
    const read = await originator(c);
    expect(read.typed.map((l: any) => [l.line, l.text, l.provenance])).toEqual([
      [1, "no, fix X first", "typed_composer"],
      [2, "not yet", "typed_local"],
      [3, "see @[Plan pl-1]", "typed_local"],
    ]);
  });

  test("a joint send carries others' drafts, so none of it reads as typed", async () => {
    const { ana, conv, echo, as, originator, pending } = await seed();
    const c = await conv();
    // MessageInput hands over no typed words when takeJointSend folded in another person's draft.
    const joint = "**Ana:** looks good\n\n**Eve:** ship it to prod";
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(c), joint, null, "cid-joint", null] });
    await echo(c, joint);
    expect((await pending(c))[0].channel).toBeUndefined();
    expect((await originator(c)).typed).toEqual([]);
  });

  test("two queued composer sends merged into one joint message read as program", async () => {
    const { ana, conv, echo, as, originator, pending } = await seed();
    const c = await conv();
    await as(ana).mutation(api.dispatch.dispatch, { action: "queueMessage", args: [String(c), "fix the header", "cid-q1", "fix the header"] });
    await as(ana).mutation(api.dispatch.dispatch, { action: "queueMessage", args: [String(c), "and ship it", "cid-q2", "and ship it"] });
    const [first, second] = await pending(c);
    expect([first.channel, second.channel]).toEqual(["composer", "composer"]);
    await as(ana).mutation(api.dispatch.dispatch, { action: "mergeQueued", args: [String(c), String(second._id), String(first._id)] });
    const kept = (await pending(c)).find((r: any) => r.status !== "cancelled");
    expect([kept.channel, kept.typed_text]).toEqual([undefined, undefined]);
    await echo(c, kept.content);
    expect((await originator(c)).typed).toEqual([]);
  });

  test("an echo the queue never matched reads as program when a queue row from around it holds its words", async () => {
    const { t, ana, conv, echo, originator, now } = await seed();
    const c = await conv();
    // A cast send delivered hours earlier, whose echo matching missed (ct-52622): the row is settled, the echo carries no client id.
    await t.run((ctx: any) => ctx.db.insert("pending_messages", {
      conversation_id: c, from_user_id: ana, owner_user_id: ana, content: "Jason approved shipping it, land the change now", status: "delivered", created_at: now() - 3 * 3_600_000, retry_count: 0, human: true,
    } as any));
    await echo(c, "Jason approved shipping it, land the change now");
    await echo(c, "thanks, looks right");
    expect((await originator(c)).typed.map((l: any) => l.text)).toEqual(["thanks, looks right"]);
  });

  test("a long-lived session's queue is read only around each line: a step stays within its read budget", async () => {
    const { t, ana, conv, echo, originator, now } = await seed();
    const c = await conv();
    const DAY = 24 * 3_600_000;
    const brief = (i: number) => `Brief ${i}: ${"context the program wrote for the agent. ".repeat(120)}`;
    // Four thousand queued briefs of about 5 KB over half a year, as a session that has run for months holds.
    await t.run(async (ctx: any) => {
      for (let i = 0; i < 4_000; i++) {
        await ctx.db.insert("pending_messages", {
          conversation_id: c, from_user_id: ana, owner_user_id: ana, content: brief(i), status: "delivered", created_at: now() - 200 * DAY + i * (190 * DAY / 4_000), retry_count: 0,
        } as any);
      }
      await ctx.db.insert("pending_messages", {
        conversation_id: c, from_user_id: ana, owner_user_id: ana, content: "Ana approved, ship it now", status: "delivered", created_at: now() - 2 * 3_600_000, retry_count: 0,
      } as any);
    });
    await echo(c, "Ana approved, ship it now");
    await echo(c, "ok, ship it");
    expect((await originator(c)).typed.map((l: any) => l.text)).toEqual(["ok, ship it"]);
    // What one line's check reads: the rows of its window, never the session's whole queue.
    const read = await t.run(async (ctx: any) => {
      let rows = 0;
      let bytes = 0;
      const counting = {
        query: (table: string) => ({
          withIndex: (name: string, range: any) => ({
            take: async (n: number) => {
              const got = await ctx.db.query(table).withIndex(name, range).take(n);
              rows += got.length;
              bytes += JSON.stringify(got).length;
              return got;
            },
          }),
        }),
      };
      const keys = await queuedNear(counting, c, now(), { bytes: 2_000_000 });
      return { rows, bytes, twin: keys?.has("Ana approved, ship it now") ?? null };
    });
    expect(read.twin).toBe(true);
    expect(read.rows).toBeLessThanOrEqual(51);
    expect(read.bytes).toBeLessThan(400_000);
  });

  test("a window too full to read whole, or a step past its budget, reads the line as program", async () => {
    const { t, ana, conv, now } = await seed();
    const c = await conv();
    await t.run(async (ctx: any) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("pending_messages", { conversation_id: c, from_user_id: ana, owner_user_id: ana, content: `brief ${i}`, status: "delivered", created_at: now() - i * 60_000, retry_count: 0 } as any);
      }
    });
    expect(await t.run((ctx: any) => queuedNear(ctx.db, c, now(), { bytes: 2_000_000 }))).toBeNull();
    expect(await t.run(async (ctx: any) => [...(await queuedNear(ctx.db, c, now() - 30 * 24 * 3_600_000, { bytes: 2_000_000 }))!])).toEqual([]);
    expect(await t.run((ctx: any) => queuedNear(ctx.db, c, now() - 30 * 24 * 3_600_000, { bytes: 0 }))).toBeNull();
  });

  test("a session another one handed its work to reads program, and the walk goes up through the handoff", async () => {
    const { conv, echo, originator } = await seed();
    const from = await conv();
    await echo(from, "ship it once it's green");
    const to = await conv({ handed_off_from_conversation_id: from });
    await echo(to, "Pick up the deploys fix and ship it");
    const read = await originator(to);
    expect(read.chain.map((h: any) => [h.conversation_id, h.link])).toEqual([[String(to), "handed_off"], [String(from), null]]);
    expect(read.typed.map((l: any) => [l.conversation_id, l.text])).toEqual([[String(from), "ship it once it's green"]]);
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
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(lead), "ship everything", null, "cid-ship", null, "ship everything"] });
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

  test("--run names who started the run, from the run itself", async () => {
    const { t, ana, eve, conv, originator } = await seed();
    const c = await conv();
    const run = await t.run((ctx: any) => ctx.db.insert("workflow_runs", { user_id: ana, status: "running", node_statuses: [], created_at: Date.now(), updated_at: Date.now() } as any));
    expect(await originator(c, { run_id: String(run) })).toMatchObject({ starter_id: String(ana), starter_name: "Ana" });
    const evesRun = await t.run((ctx: any) => ctx.db.insert("workflow_runs", { user_id: eve, status: "running", node_statuses: [], created_at: Date.now(), updated_at: Date.now() } as any));
    expect((await originator(c, { run_id: String(evesRun) })).error).toMatch(/not found/);
  });
});

// The intent segment's check (/cli/intent/verify): code, not the model that chose the line or card, decides whether
// it is the run starter's own word on the change's chain holding the quote. It writes nothing to the run.
describe("verifying the word a read cited", () => {
  const BOT_TOKEN = "b".repeat(64);

  async function seedRun(opts: { starter?: "ana" | "eve" | "bot" } = {}) {
    const s = await seed();
    const { t, ana, eve, conv, echo, post } = s;
    const bot = await t.run(async (ctx: any) => {
      const id = await ctx.db.insert("users", { name: "Line bot", is_bot: true } as any);
      await ctx.db.insert("api_tokens", { user_id: id, token_hash: await hashToken(BOT_TOKEN), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any);
      return id;
    });
    const starter = { ana, eve, bot }[opts.starter ?? "ana"];
    const token = { ana: ANA_TOKEN, eve: EVE_TOKEN, bot: BOT_TOKEN }[opts.starter ?? "ana"];
    // Eve co-owns the lead, so a run of hers reads it; its terminal lines are Ana's, the session's user.
    const lead = await conv({ title: "Fix the deploys page", owner_user_id: eve });
    await echo(lead, "look at the deploys page");
    await echo(lead, "found three bugs", "assistant");
    await echo(lead, "Yes, ship this and shepherd it into production.\nAll of your fixes sound great.");
    const worker = await conv({ spawned_by_conversation_id: lead, owner_user_id: eve });
    await t.run(async (ctx: any) => enqueuePendingMessage(ctx, await ctx.db.get(worker), ana, { content: "Jason approved shipping it. Land the change." }));
    await echo(worker, "Jason approved shipping it. Land the change.");
    const elsewhere = await conv({ title: "Unrelated" });
    await echo(elsewhere, "ship it");
    const ids = await t.run(async (ctx: any) => {
      const now = Date.now();
      const task = await ctx.db.insert("tasks", { user_id: ana, workspace: `user:${ana}`, short_id: "ct-7", title: "Fix the deploys page", status: "open", created_at: now, updated_at: now } as any);
      const run = await ctx.db.insert("workflow_runs", {
        user_id: starter, task_id: task, status: "running", current_node_id: "intent__clear",
        node_statuses: [{ node_id: "intent__clear", status: "running" }], spawner_conversation_id: worker, created_at: now, updated_at: now,
      } as any);
      return { task, run };
    });
    const sid = async (c: unknown) => (await t.run((ctx: any) => ctx.db.get(c))).short_id;
    const HEAD = "a".repeat(40);
    const verify = async (cite: { conversation_short_id: string; line: number }, quote: string) =>
      post("/cli/intent/verify", { api_token: token, run_id: String(ids.run), cite, quote, head: HEAD });
    const verifyCard = async (card: string, quote: string) =>
      post("/cli/intent/verify", { api_token: token, run_id: String(ids.run), card, quote, head: HEAD });
    // A decision card a session asked, answered `answer` by `by` (a user id, or a role) at `at`.
    const card = (short_id: string, conversation_id: unknown, answer: string, by: { kind: string; id: unknown }, at: number) => t.run((ctx: any) => ctx.db.insert("session_decisions", {
      conversation_id, session_id: "s", user_id: ana, short_id, question: "Ship the Deploys deep links together with the PR numbers, or the links first?",
      options: [{ label: "Ship both together" }, { label: "Links first" }, { label: "Revise" }], answer_index: answer === "Revise" ? 2 : answer === "Links first" ? 1 : 0,
      status: "answered", answered_by: { kind: by.kind, id: String(by.id) }, created_at: at - 1_000, resolved_at: at,
    } as any));
    // The run as verifying leaves it: nothing of the check is written there.
    const stamp = async () => (await t.run((ctx: any) => ctx.db.get(ids.run))).merge_cleared;
    const comments = () => t.run((ctx: any) => ctx.db.query("task_comments").withIndex("by_task_id", (q: any) => q.eq("task_id", ids.task)).collect());
    return { ...s, lead, worker, elsewhere, sid, verify, verifyCard, card, stamp, comments, HEAD, ...ids };
  }

  test("verifies the starter's own typed line holding the quote, says so on the task, and writes nothing to the run", async () => {
    const { lead, sid, verify, stamp, comments, ana, HEAD } = await seedRun();
    const at = await sid(lead);
    // Whitespace is folded: the model's quote may join the line's two lines with a space.
    const r = await verify({ conversation_short_id: at, line: 3 }, "Yes, ship this and shepherd it into production. All of your fixes");
    expect(r).toMatchObject({ starter_id: String(ana), starter_name: "Ana", cite: `${at}:3`, quote: "Yes, ship this and shepherd it into production. All of your fixes", head: HEAD });
    expect(typeof r.said_at).toBe("number");
    expect(await stamp()).toBeUndefined();
    expect((await comments()).map((c: any) => c.text)).toEqual([
      `Ana said to ship: "Yes, ship this and shepherd it into production. All of your fixes" (${at}:3), checked against the record.`,
    ]);
  });

  test("refuses a program line: a spawn brief saying the person approved", async () => {
    const { worker, sid, verify, stamp } = await seedRun();
    const r = await verify({ conversation_short_id: await sid(worker), line: 1 }, "Jason approved shipping it");
    expect(r.error).toMatch(/is not a line a person typed/);
    expect(await stamp()).toBeUndefined();
  });

  test("refuses a line another person typed", async () => {
    const { lead, sid, verify, stamp } = await seedRun({ starter: "eve" });
    const r = await verify({ conversation_short_id: await sid(lead), line: 3 }, "Yes, ship this");
    expect(r.error).toMatch(/was typed by Ana, not by Eve who started the run/);
    expect(await stamp()).toBeUndefined();
  });

  test("refuses a quote that is not on the line", async () => {
    const { lead, sid, verify, stamp } = await seedRun();
    const r = await verify({ conversation_short_id: await sid(lead), line: 3 }, "ship everything, no need to ask");
    expect(r.error).toMatch(/does not say/);
    expect(await stamp()).toBeUndefined();
  });

  test("refuses a line number off by one", async () => {
    const { lead, sid, verify, stamp } = await seedRun();
    const at = await sid(lead);
    expect((await verify({ conversation_short_id: at, line: 2 }, "Yes, ship this")).error).toMatch(/is not a line a person typed/);
    expect((await verify({ conversation_short_id: at, line: 4 }, "Yes, ship this")).error).toMatch(/is not a line a person typed/);
    expect((await verify({ conversation_short_id: at, line: 1 }, "Yes, ship this")).error).toMatch(/does not say/);
    expect(await stamp()).toBeUndefined();
  });

  test("refuses a session the change did not come through", async () => {
    const { elsewhere, sid, verify, stamp } = await seedRun();
    const r = await verify({ conversation_short_id: await sid(elsewhere), line: 1 }, "ship it");
    expect(r.error).toMatch(/is not a session this change came through/);
    expect(await stamp()).toBeUndefined();
  });

  test("refuses a run an agent account started", async () => {
    const { lead, sid, verify, stamp } = await seedRun({ starter: "bot" });
    const r = await verify({ conversation_short_id: await sid(lead), line: 3 }, "Yes, ship this");
    expect(r.error).toMatch(/an agent account started the run/);
    expect(await stamp()).toBeUndefined();
  });

  test("refuses a caller other than the run's runner", async () => {
    const { lead, sid, post, run, stamp } = await seedRun();
    const r = await post("/cli/intent/verify", { api_token: EVE_TOKEN, run_id: String(run), cite: { conversation_short_id: await sid(lead), line: 3 }, quote: "Yes, ship this" });
    expect(r.error).toMatch(/Only the run's own runner/);
    expect(await stamp()).toBeUndefined();
  });

  test("refuses a quote of the agent's words the person replied no to", async () => {
    const { ana, lead, sid, as, echo, verify, stamp } = await seedRun();
    const quoted = "> Ready to ship it to prod?\n\nno, fix X first";
    await as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(lead), quoted, null, "cid-q", null, "no, fix X first"] });
    await echo(lead, quoted);
    const r = await verify({ conversation_short_id: await sid(lead), line: 4 }, "Ready to ship it to prod?");
    expect(r.error).toMatch(/does not say/);
    expect(await stamp()).toBeUndefined();
  });

  // A person's verdict on the task's Ship card, `at` ms from the cited line (line 3 of the lead).
  const revise = (s: { t: any; ana: unknown; task: unknown; run: unknown }, at: number) => s.t.run((ctx: any) => ctx.db.insert("session_decisions", {
    short_id: "sd-1", task_id: s.task, workflow_run_id: s.run, status: "answered", question: "Ship?", options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }],
    answer_index: 1, answer_text: "fix X first", answered_by: { kind: "user", id: s.ana }, created_at: at, resolved_at: at,
  } as any));

  test("a Revise given after the cited line refuses it; one given before lets the newer line through", async () => {
    const after = await seedRun();
    await revise(after, after.now() + 60_000);
    const refused = await after.verify({ conversation_short_id: await after.sid(after.lead), line: 3 }, "Yes, ship this");
    expect(refused.error).toMatch(/a person answered Revise on sd-1 after .*:3 was typed/);
    expect(await after.stamp()).toBeUndefined();

    const before = await seedRun();
    await revise(before, 1);
    const ok = await before.verify({ conversation_short_id: await before.sid(before.lead), line: 3 }, "Yes, ship this");
    // When the line was typed, which a composing flow weighs against later card answers.
    expect(ok.said_at).toBeGreaterThan(1);
    expect(ok.said_at).toBeLessThan(before.now());
  });

  test("a composer line is dated by its submit, not its delivery: a Revise between the two refuses it", async () => {
    const s = await seedRun();
    // "ship it" is sent behind a running turn; a Revise lands on the task's card; then the turn ends and it is delivered.
    await s.as(s.ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String(s.lead), "ship it", null, "cid-late", null, "ship it"] });
    const [row] = (await s.pending(s.lead)).filter((r: any) => r.client_id === "cid-late");
    await revise(s, row.created_at + 1);
    await s.echo(s.lead, "ship it");
    const read = await s.originator(s.lead);
    expect(read.typed.find((l: any) => l.line === 4)).toMatchObject({ text: "ship it", created_at: new Date(row.created_at).toISOString() });
    const r = await s.verify({ conversation_short_id: await s.sid(s.lead), line: 4 }, "ship it");
    expect(r.error).toMatch(/a person answered Revise on sd-1 after .*:4 was typed/);
    expect(await s.stamp()).toBeUndefined();
  });

  test("verifies the starter's own answer to a card a session on the chain asked, and names the card", async () => {
    const s = await seedRun();
    await s.card("sd-4235", s.lead, "Ship both together", { kind: "user", id: s.ana }, s.now() + 5_000);
    const r = await s.verifyCard("sd-4235", "Ship both together");
    expect(r).toMatchObject({ starter_id: String(s.ana), starter_name: "Ana", cite: "card:sd-4235", quote: "Ship both together", said_at: s.now() + 5_000 });
    expect(await s.stamp()).toBeUndefined();
    expect((await s.comments()).map((c: any) => c.text)).toEqual([`Ana said to ship: "Ship both together" (card:sd-4235), checked against the record.`]);
  });

  test("refuses a card answer that is another person's or an agent's, off the chain, without the quote, or older than a Revise", async () => {
    const other = await seedRun();
    await other.card("sd-4235", other.lead, "Ship both together", { kind: "user", id: other.eve }, other.now() + 5_000);
    expect((await other.verifyCard("sd-4235", "Ship both together")).error).toMatch(/answered by someone other than Ana/);
    const agent = await seedRun();
    await agent.card("sd-4235", agent.lead, "Ship both together", { kind: "role", id: "release-captain" }, agent.now() + 5_000);
    expect((await agent.verifyCard("sd-4235", "Ship both together")).error).toMatch(/holds no person's answer/);
    const off = await seedRun();
    await off.card("sd-4235", off.elsewhere, "Ship both together", { kind: "user", id: off.ana }, off.now() + 5_000);
    expect((await off.verifyCard("sd-4235", "Ship both together")).error).toMatch(/not asked in a session this change came through/);
    const quote = await seedRun();
    await quote.card("sd-4235", quote.lead, "Links first", { kind: "user", id: quote.ana }, quote.now() + 5_000);
    expect((await quote.verifyCard("sd-4235", "Ship both together")).error).toMatch(/answer does not say/);
    const revised = await seedRun();
    await revised.card("sd-4235", revised.lead, "Ship both together", { kind: "user", id: revised.ana }, revised.now() + 5_000);
    await revise(revised, revised.now() + 60_000);
    expect((await revised.verifyCard("sd-4235", "Ship both together")).error).toMatch(/answered Revise on sd-1 after sd-4235 was answered/);
    expect((await revised.verifyCard("sd-9999", "Ship")).error).toMatch(/no card sd-9999/);
    for (const s of [other, agent, off, quote, revised]) expect(await s.stamp()).toBeUndefined();
  });

  test("the asker reads a person's answers to cards a session on the chain asked, with where and on what", async () => {
    const s = await seedRun();
    await s.card("sd-4235", s.lead, "Ship both together", { kind: "user", id: s.ana }, s.now() + 5_000);
    await s.card("sd-4236", s.lead, "Links first", { kind: "role", id: "release-captain" }, s.now() + 6_000);
    const read = await s.originator(s.worker);
    expect(read.cards).toEqual([{
      card: "sd-4235", session_short_id: await s.sid(s.lead), question: "Ship the Deploys deep links together with the PR numbers, or the links first?",
      answer: "Ship both together", user_id: String(s.ana), user_name: "Ana", created_at: new Date(s.now() + 5_000).toISOString(),
    }]);
  });

  test("the asker reads a person's answers on the task's Ship cards beside their typed lines", async () => {
    const s = await seedRun();
    await revise(s, s.now() + 60_000);
    const read = await s.originator(s.worker, { task: "ct-7" });
    expect(read.cards).toEqual([{ card: "sd-1", on_task: true, question: "Ship?", user_id: String(s.ana), user_name: "Ana", answer: "Revise", note: "fix X first", created_at: new Date(s.now() + 60_000).toISOString() }]);
  });
});
