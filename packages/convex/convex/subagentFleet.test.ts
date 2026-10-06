import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { createSessionFromCli } from "./spawn";
import { performSetThreadState, killConversation } from "./conversations";
import { applyMergeBackReport } from "./subagentFleet";

const OWNER = "fleet-owner";
const PARENT = {
  _id: "parent-conversation", user_id: OWNER, session_id: "parent-uuid", short_id: "parent0",
  git_root: "/repo", project_path: "/repo", owner_device_id: "mac", status: "active", message_count: 3,
};

function world() {
  const db = makeFakeDb({ users: [{ _id: OWNER }], conversations: [PARENT] });
  const ctx = { db, scheduler: { runAfter: async () => null }, auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) } };
  const spawn = (prompt: string, extra: Record<string, unknown> = {}) =>
    (createSessionFromCli as any)._handler(ctx, {
      prompt,
      agent_type: "claude_code",
      project_path: "/repo",
      git_root: "/repo",
      isolated: true,
      parent_session: PARENT.session_id,
      spawner_session: PARENT.session_id,
      subagent_caps: { per_session: 2 },
      spawn_device_id: "mac",
      merge_back: true,
      ...extra,
    });
  const commands = (name: string) => db._inserted.filter((e: any) => e.table === "daemon_commands" && e.doc.command === name).map((e: any) => e.doc);
  const pendingFor = (id: string) => db._inserted.filter((e: any) => e.table === "pending_messages" && String(e.doc.conversation_id) === id).map((e: any) => e.doc);
  // What the daemon stamps once it has made the worktree and started the worker.
  const started = (id: string, n: number) => db.patch(id, { worktree_path: `/repo/.codecast/worktrees/w${n}`, owner_device_id: "mac" });
  return { db, ctx, spawn, commands, pendingFor, started };
}

describe("the fleet cap", () => {
  test("a spawn past the session's limit queues without starting, and starts when a worker ends done", async () => {
    const w = world();
    const a = await w.spawn("task a");
    const b = await w.spawn("task b");
    const c = await w.spawn("task c");
    expect([a.queued, b.queued, c.queued]).toEqual([undefined, undefined, true]);
    expect(w.commands("start_session")).toHaveLength(2);
    // The queued worker's prompt waits with it: a pending message would bring it up early.
    expect(w.pendingFor(c.conversation_id)).toHaveLength(0);
    const queuedRow = await w.db.get(c.conversation_id);
    expect(queuedRow.subagent_slot).toBe("queued");
    expect(queuedRow.subagent_caps).toEqual({ per_session: 2, per_machine: 24 });

    await w.started(a.conversation_id, 1);
    await performSetThreadState(w.ctx as any, await w.db.get(a.conversation_id), "finished the task", "done");

    expect((await w.db.get(a.conversation_id)).subagent_slot).toBeUndefined();
    expect((await w.db.get(c.conversation_id)).subagent_slot).toBe("running");
    expect(w.commands("start_session")).toHaveLength(3);
    expect(w.pendingFor(c.conversation_id).map((m: any) => m.content)).toEqual(["task c"]);
  });

  test("a done worker's worktree is merged back on its own machine; a blocked one keeps it and tells the parent", async () => {
    const w = world();
    const a = await w.spawn("task a");
    const b = await w.spawn("task b");
    await w.started(a.conversation_id, 1);
    await w.started(b.conversation_id, 2);

    await performSetThreadState(w.ctx as any, await w.db.get(a.conversation_id), "done", "done");
    const [merge] = w.commands("merge_back");
    expect(merge.target_device_id).toBe("mac");
    expect(JSON.parse(merge.args)).toEqual({ conversation_id: a.conversation_id, worktree_path: "/repo/.codecast/worktrees/w1", target_path: "/repo" });
    expect((await w.db.get(a.conversation_id)).merge_back.state).toBe("pending");

    await performSetThreadState(w.ctx as any, await w.db.get(b.conversation_id), "stuck on creds", "blocked");
    expect(w.commands("merge_back")).toHaveLength(1);
    expect((await w.db.get(b.conversation_id)).merge_back.state).toBe("kept");
    const notes = w.pendingFor(PARENT._id).map((m: any) => m.content);
    expect(notes.some((n: string) => n.includes("ended blocked") && n.includes("/repo/.codecast/worktrees/w2"))).toBe(true);

    // The machine reports a conflict: the chip says so and the parent hears which files.
    await applyMergeBackReport(w.ctx, OWNER as any, { conversation_id: a.conversation_id, state: "conflict", files: ["src/a.ts"] });
    expect((await w.db.get(a.conversation_id)).merge_back).toMatchObject({ state: "conflict", files: ["src/a.ts"] });
    expect(w.pendingFor(PARENT._id).some((m: any) => m.content.includes("- src/a.ts"))).toBe(true);

    // A later done after a conflict tries again: the parent may have resolved it.
    await performSetThreadState(w.ctx as any, await w.db.get(a.conversation_id), "done again", "done");
    expect(w.commands("merge_back")).toHaveLength(2);
  });

  test("a kill frees the slot and keeps the worktree", async () => {
    const w = world();
    const a = await w.spawn("task a");
    await w.spawn("task b");
    const c = await w.spawn("task c");
    await w.started(a.conversation_id, 1);
    await killConversation(w.ctx, OWNER as any, { conversation_id: a.conversation_id as any, mark_completed: true });
    expect((await w.db.get(a.conversation_id)).merge_back.state).toBe("kept");
    expect((await w.db.get(c.conversation_id)).subagent_slot).toBe("running");
  });

  test("without merge back, or without a worktree, nothing is merged", async () => {
    const w = world();
    const a = await w.spawn("task a", { merge_back: undefined });
    await w.started(a.conversation_id, 1);
    await performSetThreadState(w.ctx as any, await w.db.get(a.conversation_id), "done", "done");
    expect(w.commands("merge_back")).toHaveLength(0);
    expect((await w.db.get(a.conversation_id)).merge_back).toBeUndefined();
  });

  test("a plain spawn is not counted", async () => {
    const w = world();
    const r = await (createSessionFromCli as any)._handler(w.ctx, { prompt: "x", agent_type: "claude_code", subagent_caps: { per_session: 1 } });
    expect((await w.db.get(r.conversation_id)).subagent_slot).toBeUndefined();
  });
});
