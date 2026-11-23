// `cast sessions` classifies through classifyWorkState with its own reads, and
// the inbox places through placeProjectableRow. Both take the verified wake
// from rowVerifiedWake, so a session parked on a wake files the same on both.
// The shape is jx729tp: a lead whose standing trigger outlives its managed
// session, that answered a person and pinned dormant.
import { describe, expect, test } from "bun:test";
import { deriveLiveAt, pinPredatesUserMessage, placeProjectableRow } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";
import { cliSessionClassifier } from "./cliSessionClassifier";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { classifyWorkStates } from "./conversations";
import { deriveConversationVerdict } from "./notifications";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const OWNER = "users_owner";

const lead = (extra: Record<string, unknown> = {}) => ({
  _id: "conversations_lead", user_id: OWNER, status: "completed", agent_type: "claude_code",
  updated_at: NOW - 5 * HOUR, message_count: 136, last_message_role: "assistant",
  armed_trigger_kind: "standing", last_turn_origin: "person",
  last_message_preview: "yes, start a fix session", thread_state_status: "dormant",
  ...extra,
});

async function cliState(conv: Record<string, unknown>, managed?: Record<string, unknown>): Promise<string> {
  const db = makeFakeDb({ conversations: [conv], managed_sessions: managed ? [managed] : [], agent_tasks: [], messages: [] });
  return (await cliSessionClassifier({ db }, NOW).classify(conv)).work_state;
}

function inboxState(conv: Record<string, unknown>, managed?: Record<string, any>): string {
  const facts = {
    ...conv,
    agent_status: managed?.agent_status ?? null,
    agent_status_updated_at: managed?.agent_status_updated_at ?? null,
    last_heartbeat: managed?.last_heartbeat ?? null,
    daemon_alive_until: managed ? NOW + 60_000 : null,
  } as any;
  return placeProjectableRow({ ...facts, ...deriveLiveAt(facts, NOW) }, false, NOW).work_state;
}

describe("cast sessions and the inbox agree on a verified wake", () => {
  test.each([
    ["the jx729tp shape", {}, "dormant"],
    ["its trigger cancelled", { armed_trigger_kind: "none" }, "needs_input"],
    ["held by a server-seen blocker instead", { armed_trigger_kind: "none", parked_wake_kind: "blocker" }, "dormant"],
    // A task blocker is exact; a wait (a webhook can be lost) lives 72h.
    ["a task blocker quiet 4 days", { armed_trigger_kind: "none", parked_wake_kind: "blocker", updated_at: NOW - 96 * HOUR }, "dormant"],
    ["held by a wait", { armed_trigger_kind: "none", parked_wake_kind: "wait" }, "dormant"],
    ["a wait past its 72h", { armed_trigger_kind: "none", parked_wake_kind: "wait", updated_at: NOW - 73 * HOUR }, "needs_input"],
    // A run needs its spawner's machine; with no daemon nothing delivers its wake.
    ["held only by a run, with no daemon", { armed_trigger_kind: "none", parked_wake_kind: "run" }, "needs_input"],
    ["a blocked pin", { thread_state_status: "blocked" }, "needs_input"],
    // A turn opened after the pin (a session message): the pin is not its answer.
    ["a pin older than the latest turn", { thread_state_at: NOW - 6 * HOUR, last_turn_at: NOW - 5 * HOUR }, "needs_input"],
    ["a pin newer than the latest turn", { thread_state_at: NOW - 5 * HOUR, last_turn_at: NOW - 6 * HOUR }, "dormant"],
    // A hosted conversation's routine never parks it.
    ["a hosted conversation's trigger", { agent_type: "codecast" }, "needs_input"],
  ])("%s", async (_name, extra, want) => {
    const conv = lead(extra);
    expect(inboxState(conv)).toBe(want);
    expect(await cliState(conv)).toBe(want);
  });

  // A daemon-declared dormant that names no wake the system can verify holds
  // for DORMANT_CLAIM_TTL_MS of quiet, then files needs_input on every surface.
  test.each([
    ["a bare claim quiet 1h", 1, {}, "dormant"],
    ["a bare claim quiet 3h", 3, {}, "needs_input"],
    ["a claim quiet 3h held by a server-seen run", 3, { parked_wake_kind: "run" }, "dormant"],
  ])("%s", async (_name, quietHours, extra, want) => {
    const conv = {
      _id: "conversations_claim", user_id: OWNER, status: "active", agent_type: "claude_code",
      updated_at: NOW - quietHours * HOUR, message_count: 30, last_message_role: "assistant", ...extra,
    };
    const managed = {
      _id: "managed_claim", user_id: OWNER, conversation_id: conv._id, agent_status: "dormant",
      agent_status_updated_at: conv.updated_at, last_heartbeat: NOW - 5_000,
    };
    expect(inboxState(conv, managed)).toBe(want);
    expect(await cliState(conv, managed)).toBe(want);
  });
  // A process that exited pinned dormant on a server-seen park files dormant
  // on every surface, as it does once its managed row ages out.
  test.each([
    ["a stopped process parked on a blocker", { parked_wake_kind: "blocker" }, "dormant"],
    ["a stopped process with no park", {}, "needs_input"],
  ])("%s", async (_name, extra, want) => {
    const conv = {
      _id: "conversations_dead", user_id: OWNER, status: "active", agent_type: "claude_code", thread_state_status: "dormant",
      updated_at: NOW - 3 * HOUR, message_count: 30, last_message_role: "assistant", ...extra,
    };
    const managed = {
      _id: "managed_dead", user_id: OWNER, conversation_id: conv._id, agent_status: "stopped",
      agent_status_updated_at: conv.updated_at, last_heartbeat: NOW - 5_000,
    };
    expect(inboxState(conv, managed)).toBe(want);
    expect(await cliState(conv, managed)).toBe(want);
  });
});

// `cast feed`, `cast search` and `cast context` count a producing subagent
// child as the inbox and the push do: a settled parent is parked on it.
describe("a producing subagent child parks its settled parent on every surface", () => {
  test("pinned dormant, daemon dormant, quiet 3h, child produced 10s ago", async () => {
    const t = convexTest(schema, allModules);
    const now = Date.now();
    const out = await t.run(async (ctx: any) => {
      const user = await ctx.db.insert("users", { name: "Me" } as any);
      const parent = await ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: "p", title: "p", started_at: 1, updated_at: now - 3 * HOUR,
        status: "active", message_count: 5, last_message_role: "assistant", thread_state_status: "dormant", thread_state_at: now - 3 * HOUR,
      } as any);
      const child = await ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: "c", title: "c", started_at: 1, updated_at: now - 10_000,
        status: "active", message_count: 50, is_subagent: true, parent_conversation_id: parent,
      } as any);
      await ctx.db.insert("managed_sessions", { user_id: user, session_id: "p", conversation_id: parent, agent_status: "dormant", agent_status_updated_at: now - 3 * HOUR, last_heartbeat: now - 5_000, pid: 1, started_at: 1 } as any);
      await ctx.db.insert("managed_sessions", { user_id: user, session_id: "c", conversation_id: child, agent_status: "working", agent_status_updated_at: now - 10_000, last_heartbeat: now - 5_000, pid: 2, started_at: 1 } as any);
      const row = await ctx.db.get(parent);
      const kids = (await ctx.db.query("conversations").collect()).filter((k: any) => k.parent_conversation_id);
      const cli = await cliSessionClassifier(ctx, now).classify(row);
      const inbox = await classifyWorkStates(ctx, user, [row], new Map([[String(parent), kids]]), now);
      return { cli: cli.work_state, inbox: inbox.get(String(parent)) };
    });
    expect(out).toEqual({ cli: "dormant", inbox: "dormant" });
  });
});

// The server backstop for a daemon that overwrote a declared pin with
// `working`: the server decays the quiet `working` to `idle`, and a pin
// written in or after the latest turn speaks over that idle. Every surface
// agrees: the shared placement (web replica), the server's classifier, the
// CLI and the needs-input push.
describe("a fresh pin speaks over a decayed idle on every surface", () => {
  test.each([
    ["pinned done, pin newer than the last turn", { thread_state_status: "done" }, "done"],
    ["pinned dormant on a blocker", { thread_state_status: "dormant", parked_wake_kind: "blocker" }, "dormant"],
    ["a pin older than the last turn", { thread_state_status: "done", turnAfterPin: HOUR }, "needs_input"],
    // Strict, as the daemon compares: a turn seconds after the pin is one it never answered.
    ["a cast send 3s after a done pin", { thread_state_status: "done", turnAfterPin: 3_000, last_turn_origin: "machine" }, "needs_input"],
    ["a person's yes 8s after a dormant pin", { thread_state_status: "dormant", parked_wake_kind: "blocker", turnAfterPin: 8_000, last_turn_origin: "person" }, "needs_input"],
    ["no turn stamp", { thread_state_status: "done", last_turn_at: undefined }, "needs_input"],
    // An idle the daemon reported itself always wins over a fresh pin.
    ["the daemon reported idle, fresh done pin", { thread_state_status: "done", daemon: "idle" }, "needs_input"],
    ["the daemon reported idle, fresh dormant pin on a blocker", { thread_state_status: "dormant", parked_wake_kind: "blocker", daemon: "idle" }, "needs_input"],
  ])("%s", async (_name, extra, want) => {
    const t = convexTest(schema, allModules);
    const now = Date.now();
    const pinnedAt = now - 3 * HOUR;
    const { turnAfterPin, daemon = "working", ...rest } = extra as Record<string, any>;
    const fields: Record<string, unknown> = { thread_state_at: pinnedAt, last_turn_at: pinnedAt - 60_000, ...rest };
    if (turnAfterPin !== undefined) fields.last_turn_at = pinnedAt + turnAfterPin;
    const out = await t.run(async (ctx: any) => {
      const user = await ctx.db.insert("users", { name: "Me" } as any);
      const id = await ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: "s", title: "s", started_at: 1, updated_at: pinnedAt,
        status: "active", message_count: 5, last_message_role: "assistant", ...fields,
      } as any);
      // The daemon's last word was `working` (a misread pane), long quiet: the server decays it.
      const managed = { user_id: user, session_id: "s", conversation_id: id, agent_status: daemon, agent_status_updated_at: pinnedAt, last_heartbeat: now - 5_000, pid: 1, started_at: 1 };
      await ctx.db.insert("managed_sessions", managed as any);
      const row = await ctx.db.get(id);
      const session = await ctx.db.query("managed_sessions").first();
      const cli = (await cliSessionClassifier(ctx, now).classify(row)).work_state;
      const server = (await classifyWorkStates(ctx, user, [row], new Map(), now)).get(String(id));
      const push = (await deriveConversationVerdict(ctx, row, session, now)).state;
      // The replica keeps the raw status beside the trusted one, as projectableRowOf does.
      const facts = { ...row, agent_status: daemon, raw_agent_status: daemon, agent_status_updated_at: pinnedAt, last_heartbeat: now - 5_000, daemon_alive_until: now + 60_000 } as any;
      const replica = placeProjectableRow({ ...facts, ...deriveLiveAt(facts, now) }, false, now).work_state;
      return { cli, server, push, replica };
    });
    expect(out).toEqual({ cli: want, server: want, push: want, replica: want });
  });
});

// One rule for a run on every path: it counts only while the row's daemon
// heartbeat lives, on the CLI as in the inbox.
describe("a run stamp follows the daemon's heartbeat on every surface", () => {
  test.each([
    ["hibernated, heartbeat alive", { agent_status: "hibernated", last_heartbeat: NOW - 5_000 }, "dormant"],
    ["settled idle under a fresh pin, heartbeat dead", { agent_status: "idle", last_heartbeat: NOW - 5 * HOUR }, "needs_input"],
  ])("%s", async (_name, m, want) => {
    const conv = {
      _id: "conversations_run", user_id: OWNER, status: "active", agent_type: "claude_code", updated_at: NOW - 5 * HOUR, message_count: 30,
      last_message_role: "assistant", thread_state_status: "dormant", thread_state_at: NOW - 5 * HOUR, last_turn_at: NOW - 5 * HOUR - 60_000,
      parked_wake_kind: "run",
    };
    const managed = { _id: "managed_run", user_id: OWNER, conversation_id: conv._id, agent_status_updated_at: NOW - 5 * HOUR, ...m };
    expect(inboxState(conv, managed)).toBe(want);
    expect(await cliState(conv, managed)).toBe(want);
  });
});

// A row with no last_turn_at (no turn since the stamp existed): the doc
// readers (CLI, server, push) compute pinPredatesUserMessage from the raw
// last_user_message_at, and the replica reads the server's bit off the row.
describe("a legacy pin agrees on every surface", () => {
  test.each([
    ["a later turn a minute past the pin", 20 * HOUR, "needs_input"],
    ["the pin's own tool result 140ms later", 30 * HOUR - 140, "dormant"],
  ])("%s", async (_name, ago, want) => {
    const t = convexTest(schema, allModules);
    const now = Date.now();
    const out = await t.run(async (ctx: any) => {
      const user = await ctx.db.insert("users", { name: "Me" } as any);
      const id = await ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: "s", title: "s", started_at: 1, updated_at: now - (ago as number),
        status: "active", message_count: 40, last_message_role: "assistant", parked_wake_kind: "blocker",
        thread_state_status: "dormant", thread_state_at: now - 30 * HOUR, last_user_message_at: now - (ago as number),
      } as any);
      const row = await ctx.db.get(id);
      const cli = (await cliSessionClassifier(ctx, now).classify(row)).work_state;
      const server = (await classifyWorkStates(ctx, user, [row], new Map(), now)).get(String(id));
      const push = (await deriveConversationVerdict(ctx, row, null, now)).state;
      const { last_user_message_at: _raw, ...shipped } = row;
      const facts = { ...shipped, pin_predates_user_message: pinPredatesUserMessage(row), agent_status: null } as any;
      const replica = placeProjectableRow({ ...facts, ...deriveLiveAt(facts, now) }, false, now).work_state;
      return { cli, server, push, replica };
    });
    expect(out).toEqual({ cli: want, server: want, push: want, replica: want });
  });
});
