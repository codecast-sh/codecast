import { describe, expect, test } from "bun:test";
import { applyContextRecovery, contextRecoveryBlocker, contextRecoveryMode, pickLatestMessages, recoveryInput } from "./handoff";
import { onFreshApiErrorPark } from "./accountSwitch";
import { parkWalk } from "./inboxFilters";
import { makeFakeDb } from "./testDb";
import { composeContextRebuildPrompt, composeContextRecoveryPrompt, CONTEXT_RECOVERY_COOLDOWN_MS, CONTEXT_RECOVERY_DELAY_MS } from "@codecast/shared/contracts";

const USER = "users_owner";
const CONV = "conversations_full";
const PARKED_AT = 1_700_000_000_000;

function seed(extra: Record<string, unknown> = {}) {
  return makeFakeDb({
    conversations: [{
      _id: CONV,
      user_id: USER,
      short_id: "jx7full",
      title: "Market growth",
      session_id: "4b1c2d3e-0000-4000-8000-000000000001",
      agent_type: "claude_code",
      model: "claude-opus",
      effort: "high",
      project_path: "/repo",
      git_root: "/repo",
      message_count: 6,
      status: "active",
      updated_at: 1,
      pending_api_error: true,
      pending_api_error_kind: "context",
      pending_api_error_at: PARKED_AT,
      ...extra,
    }],
    messages: [
      { _id: "m0", conversation_id: CONV, role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: grow a market.", timestamp: 0 },
      { _id: "m1", conversation_id: CONV, role: "user", content: "Why has no market grown?", timestamp: 1 },
      { _id: "m2", conversation_id: CONV, role: "assistant", content: "Reading the cold engine logs.", timestamp: 2 },
      { _id: "m3", conversation_id: CONV, role: "user", content: "Also check the grading backlog.", timestamp: 3 },
      { _id: "m4", conversation_id: CONV, role: "assistant", content: "Prompt is too long", timestamp: 4 },
      { _id: "m5", conversation_id: CONV, role: "user", content: "/compact", timestamp: 5 },
    ],
    pending_messages: [],
    daemon_commands: [],
    devices: [],
    anchors: [],
  });
}

describe("context recovery", () => {
  test("first rebuilds the same session from the server copy, prompt queued for the new pane", async () => {
    const db = seed();
    const input = await (recoveryInput as any)._handler({ db }, { conversation_id: CONV });
    expect(input.mode).toBe("rebuild");

    const prompt = composeContextRebuildPrompt({ source: input.source });
    const ctx = { db, scheduler: { runAfter: async () => {} } };
    const res = await (applyContextRecovery as any)._handler(ctx, { conversation_id: CONV, prompt, mode: "rebuild", parked_at: PARKED_AT });
    expect(res).toEqual({ recovered: true, mode: "rebuild" });

    const conv = await db.get(CONV as any);
    expect(conv.pending_api_error).toBe(false);
    expect(conv.context_recovery_mode).toBe("rebuild");
    expect((await db.query("pending_messages").collect()).map((p: any) => p.content)).toEqual([prompt]);

    const commands = await db.query("daemon_commands").collect();
    expect(commands.map((c: any) => c.command)).toEqual(["kill_session", "resume_session"]);
    const args = JSON.parse(commands[1].args);
    expect(args.force_reconstitute).toBe(true);
    expect(args.session_id).toBe("4b1c2d3e-0000-4000-8000-000000000001"); // the same session, rebuilt
  });

  test("an overflow right after a rebuild falls back to a fresh agent with the brief as its launch prompt", async () => {
    const db = seed({ context_recovered_at: Date.now() - 60_000, context_recovery_mode: "rebuild" });
    const input = await (recoveryInput as any)._handler({ db }, { conversation_id: CONV });
    expect(input.mode).toBe("brief");
    expect(input.source.short_id).toBe("jx7full");
    expect(input.last_summary).toContain("Summary: grow a market.");
    // The overflow banner and the slash command are not the work.
    expect(input.latest.map((m: any) => m.content)).toEqual([
      "Why has no market grown?",
      "Reading the cold engine logs.",
      "Also check the grading backlog.",
    ]);

    const prompt = composeContextRecoveryPrompt({ source: input.source, brief: "## Goal\n\nGrow a market.", latest: input.latest, lastSummary: input.last_summary });
    expect(prompt).toContain("## Your last compaction summary");
    const scheduled: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (...a: any[]) => { scheduled.push(a); } } };
    const res = await (applyContextRecovery as any)._handler(ctx, { conversation_id: CONV, prompt, mode: "brief", parked_at: PARKED_AT });
    expect(res.recovered).toBe(true);

    const conv = await db.get(CONV as any);
    expect(conv.pending_api_error).toBe(false);
    expect(conv.pending_api_error_kind).toBeUndefined();
    expect(typeof conv.context_recovered_at).toBe("number");
    expect(conv.context_recovery_mode).toBe("brief");

    const pending = await db.query("pending_messages").collect();
    expect(pending.map((p: any) => p.content)).toEqual([prompt]);

    const commands = await db.query("daemon_commands").collect();
    expect(commands.map((c: any) => c.command)).toEqual(["start_session"]);
    const args = JSON.parse(commands[0].args);
    expect(args.conversation_id).toBe(CONV);
    expect(args.agent_type).toBe("claude");
    expect(args.session_id).toBeUndefined(); // a fresh native session, never the overflowed one
    expect(args.model).toBe("opus");
    expect(args.effort).toBe("high");
  });

  test("a /compact that landed first, or a newer park, wins", async () => {
    const db = seed();
    const ctx = { db, scheduler: { runAfter: async () => {} } };
    expect((await (applyContextRecovery as any)._handler(ctx, { conversation_id: CONV, prompt: "x", parked_at: PARKED_AT - 1 })).recovered).toBe(false);
    await db.patch(CONV as any, { pending_api_error: false, pending_api_error_kind: undefined });
    expect((await (applyContextRecovery as any)._handler(ctx, { conversation_id: CONV, prompt: "x", parked_at: PARKED_AT })).recovered).toBe(false);
    expect(await db.query("daemon_commands").collect()).toEqual([]);
  });

  test("a prompt written for one rung is not applied once the rung changed", async () => {
    const db = seed();
    const ctx = { db, scheduler: { runAfter: async () => {} } };
    expect((await (applyContextRecovery as any)._handler(ctx, { conversation_id: CONV, prompt: "x", mode: "brief", parked_at: PARKED_AT })).recovered).toBe(false);
  });

  test("blockers: cooldown, finished, non-local agents", () => {
    const parked = { pending_api_error: true, pending_api_error_kind: "context", project_path: "/repo", agent_type: "claude_code" };
    const now = PARKED_AT;
    expect(contextRecoveryBlocker(parked, now)).toBeNull();
    expect(contextRecoveryBlocker({ ...parked, agent_type: "codex" }, now)).toBeNull();
    expect(contextRecoveryBlocker({ ...parked, context_recovered_at: now - 60_000 }, now)).toBe("recovered recently");
    expect(contextRecoveryBlocker({ ...parked, context_recovered_at: now - 60_000, context_recovery_mode: "brief" }, now)).toBe("recovered recently");
    expect(contextRecoveryBlocker({ ...parked, context_recovered_at: now - 60_000, context_recovery_mode: "rebuild" }, now)).toBeNull();
    expect(contextRecoveryBlocker({ ...parked, context_recovered_at: now - CONTEXT_RECOVERY_COOLDOWN_MS - 1 }, now)).toBeNull();
    expect(contextRecoveryBlocker({ ...parked, status: "completed" }, now)).not.toBeNull();
    expect(contextRecoveryBlocker({ ...parked, agent_type: "cursor" }, now)).not.toBeNull();
    expect(contextRecoveryBlocker({ ...parked, pending_api_error_kind: "limit" }, now)).not.toBeNull();
  });

  test("rungs: rebuild first, brief after a recent rebuild, brief always for an agent that cannot rebuild", () => {
    const now = PARKED_AT;
    expect(contextRecoveryMode({ agent_type: "claude_code" }, now)).toBe("rebuild");
    expect(contextRecoveryMode({ agent_type: "claude_code", context_recovered_at: now - 60_000, context_recovery_mode: "rebuild" }, now)).toBe("brief");
    expect(contextRecoveryMode({ agent_type: "claude_code", context_recovered_at: now - CONTEXT_RECOVERY_COOLDOWN_MS - 1, context_recovery_mode: "brief" }, now)).toBe("rebuild");
    expect(contextRecoveryMode({ agent_type: "codex" }, now)).toBe("brief");
  });

  test("latest messages: the exchange from the third newest user turn on, oldest first", () => {
    const rows = [
      { role: "assistant", content: "final reply", timestamp: 9 },
      { role: "user", content: "u4", timestamp: 8 },
      { role: "assistant", content: "older reply", timestamp: 7 },
      { role: "user", content: "u3", timestamp: 6 },
      { role: "user", content: "u2", timestamp: 5 },
      { role: "user", content: "u1", timestamp: 4 },
    ];
    expect(pickLatestMessages(rows).map((m) => m.content)).toEqual(["u2", "u3", "older reply", "u4", "final reply"]);
  });

  test("a fresh context park schedules the recovery for that conversation", async () => {
    const scheduled: any[] = [];
    await onFreshApiErrorPark({ scheduler: { runAfter: async (ms: number, _fn: any, args: any) => { scheduled.push({ ms, args }); } } }, USER as any, "context", CONV as any);
    expect(scheduled.some((s) => s.ms === CONTEXT_RECOVERY_DELAY_MS && s.args.conversation_id === CONV)).toBe(true);
  });
});

describe("a context park holds until the agent answers or a compaction works", () => {
  const banner = { role: "assistant", content: "Prompt is too long", timestamp: 1 };
  const queued = { role: "user", content: "<session-message from=\"jx7\">news</session-message>", timestamp: 2 };

  test("a queued user message does not lift it, in the same batch or a later one", () => {
    expect(parkWalk([banner, queued]).newest).toBe(banner);
    expect(parkWalk([queued], "context")).toEqual({ newest: undefined, liftedAt: 0 });
  });

  test("an agent reply or a compaction summary lifts it", () => {
    expect(parkWalk([queued, { role: "assistant", content: "On it.", timestamp: 3 }], "context").liftedAt).toBe(3);
    const summary = { role: "user", content: "This session is being continued from a previous conversation that ran out of context.", timestamp: 3 };
    expect(parkWalk([summary], "context").liftedAt).toBe(3);
  });

  test("other parks still lift on a user turn", () => {
    expect(parkWalk([{ ...banner, content: "You've hit your session limit · resets 3pm" }, queued]).newest).toBe(queued);
    expect(parkWalk([queued], "limit").liftedAt).toBe(2);
  });
});
