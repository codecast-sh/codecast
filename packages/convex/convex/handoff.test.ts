import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  applyHandoffLink,
  buildHandoffBriefPrompt,
  fallbackHandoffBrief,
  handoffChildFields,
  handoffStateLine,
  shapeHandoffTranscript,
  HANDOFF_HEAD_MESSAGES,
  HANDOFF_TAIL_MESSAGES,
} from "./handoff";

const USER = "u_runner";

function source(extra: Record<string, any> = {}) {
  return {
    _id: "conv-source",
    user_id: USER,
    short_id: "src1234",
    session_id: "s-src",
    title: "Fix the auth race",
    agent_type: "claude_code",
    model: "opus",
    message_count: 42,
    active_task_id: "task-1",
    active_plan_id: "plan-1",
    plan_ids: ["plan-1"],
    ...extra,
  };
}

function tables(src = source()) {
  return {
    conversations: [src, { _id: "conv-child", user_id: USER, short_id: "chl5678", agent_type: "codex", started_at: 2 }],
    tasks: [{ _id: "task-1", short_id: "ct-9", title: "Auth", conversation_ids: ["conv-source"] }],
    plans: [{ _id: "plan-1", short_id: "pl-3", title: "Auth plan", session_ids: ["conv-source"], current_session_id: "conv-source" }],
    managed_sessions: [],
    entity_conversations: [],
    live_activity_refresh: [],
  } as Record<string, any[]>;
}

function ctx(db: any) {
  return { db, scheduler: { runAfter: async () => {} } } as any;
}

describe("handoffChildFields — what the child row is born with", () => {
  test("the back pointer plus the source's task and plan binding", () => {
    expect(handoffChildFields(source())).toEqual({
      handed_off_from_conversation_id: "conv-source",
      active_task_id: "task-1",
      active_plan_id: "plan-1",
      plan_ids: ["plan-1"],
    });
  });

  test("an unbound source hands over only the pointer", () => {
    expect(handoffChildFields(source({ active_task_id: undefined, active_plan_id: undefined, plan_ids: undefined }))).toEqual({
      handed_off_from_conversation_id: "conv-source",
    });
  });
});

describe("applyHandoffLink — the source side, same mutation", () => {
  test("points the source forward, joins the task and plan, pins the state done", async () => {
    const t = tables();
    const db = makeFakeDb(t);
    await applyHandoffLink(ctx(db), USER, t.conversations[0], { _id: "conv-child" as any, short_id: "chl5678", agent_type: "codex", model: null });

    const src = await db.get("conv-source");
    expect(src.handed_off_to_conversation_id).toBe("conv-child");
    expect(src.thread_state).toBe("Handed off to chl5678 on Codex");
    expect(src.thread_state_status).toBe("done");
    expect(src.thread_state_msg_count).toBe(42);

    const task = await db.get("task-1");
    expect(task.conversation_ids).toEqual(["conv-source", "conv-child"]);
    const plan = await db.get("plan-1");
    expect(plan.session_ids).toEqual(["conv-source", "conv-child"]);
    expect(plan.current_session_id).toBe("conv-child");
  });

  test("a second handoff of the same source repoints without duplicating list entries", async () => {
    const t = tables();
    t.tasks[0].conversation_ids = ["conv-source", "conv-child"];
    t.plans[0].session_ids = ["conv-source", "conv-child"];
    const db = makeFakeDb(t);
    await applyHandoffLink(ctx(db), USER, t.conversations[0], { _id: "conv-child" as any, short_id: "chl5678", agent_type: "claude_code", model: "sonnet" });
    expect((await db.get("task-1")).conversation_ids).toEqual(["conv-source", "conv-child"]);
    expect((await db.get("plan-1")).session_ids).toEqual(["conv-source", "conv-child"]);
    expect((await db.get("conv-source")).thread_state).toBe("Handed off to chl5678 on Claude (sonnet)");
  });

  test("an unbound source still gets its pointer and pin", async () => {
    const t = tables(source({ active_task_id: undefined, active_plan_id: undefined, plan_ids: undefined }));
    const db = makeFakeDb(t);
    await applyHandoffLink(ctx(db), USER, t.conversations[0], { _id: "conv-child" as any, short_id: "chl5678", agent_type: "gemini" });
    const src = await db.get("conv-source");
    expect(src.handed_off_to_conversation_id).toBe("conv-child");
    expect(src.thread_state).toBe("Handed off to chl5678 on Gemini");
    expect((await db.get("task-1")).conversation_ids).toEqual(["conv-source"]);
  });

  test("the state line survives normalization", () => {
    expect(handoffStateLine("abc1234", "claude_code", "opus")).toBe("Handed off to abc1234 on Claude (opus)");
  });
});

describe("shapeHandoffTranscript — what Haiku reads", () => {
  const row = (i: number, role = i % 2 ? "assistant" : "user", extra: Record<string, any> = {}) =>
    ({ role, content: `message ${i} ${"x".repeat(20)}`, ...extra });

  test("keeps readable turns oldest first and drops tool carriers", () => {
    const newestFirst = [row(3), row(2, "assistant", { tool_results: [{}] }), row(1), row(0)];
    const out = shapeHandoffTranscript(newestFirst);
    expect(out.map((m) => m.content.slice(0, 9))).toEqual(["message 0", "message 1", "message 3"]);
  });

  test("a long transcript keeps the head and the tail", () => {
    const n = HANDOFF_HEAD_MESSAGES + HANDOFF_TAIL_MESSAGES + 30;
    const newestFirst = Array.from({ length: n }, (_, i) => row(n - 1 - i));
    const out = shapeHandoffTranscript(newestFirst);
    expect(out.length).toBe(HANDOFF_HEAD_MESSAGES + HANDOFF_TAIL_MESSAGES);
    expect(out[0].content.startsWith("message 0 ")).toBe(true);
    expect(out[HANDOFF_HEAD_MESSAGES - 1].content.startsWith(`message ${HANDOFF_HEAD_MESSAGES - 1} `)).toBe(true);
    expect(out[HANDOFF_HEAD_MESSAGES].content.startsWith(`message ${n - HANDOFF_TAIL_MESSAGES} `)).toBe(true);
    expect(out[out.length - 1].content.startsWith(`message ${n - 1} `)).toBe(true);
  });

  test("long messages are clipped, the final assistant message less so", () => {
    const big = "y".repeat(10_000);
    const out = shapeHandoffTranscript([{ role: "assistant", content: big }, { role: "user", content: big }]);
    expect(out[0].content.length).toBeLessThan(2000);
    expect(out[0].content).toContain("more chars]");
    expect(out[1].content.length).toBeGreaterThan(5000);
    expect(out[1].content.length).toBeLessThan(6100);
  });
});

describe("buildHandoffBriefPrompt / fallbackHandoffBrief", () => {
  const input = {
    title: "Fix the auth race",
    agent: "Claude (opus)",
    thread_state: "Rewrite done, tests green\nNext: deploy",
    task_short_id: "ct-9",
    plan_short_id: null,
    messages: [
      { role: "user" as const, content: "Fix the race in auth." },
      { role: "assistant" as const, content: "Done: patched login.ts; bun test passes." },
    ],
  };

  test("the prompt carries the facts, the pinned state and the transcript", () => {
    const p = buildHandoffBriefPrompt(input);
    expect(p).toContain("Title: Fix the auth race");
    expect(p).toContain("Bound task: ct-9");
    expect(p).not.toContain("Bound plan");
    expect(p).toContain("Rewrite done, tests green");
    expect(p).toContain("User: Fix the race in auth.");
    expect(p).toContain("Assistant: Done: patched login.ts");
    expect(p).toContain("## Next steps");
  });

  test("the fallback brief uses the state, the last assistant word and the opening ask", () => {
    const b = fallbackHandoffBrief(input);
    expect(b).toContain("## Pinned state\n\nRewrite done, tests green");
    expect(b).toContain("## Last message from the source agent\n\nDone: patched login.ts");
    expect(b).toContain("## Opening request\n\nFix the race in auth.");
    expect(b).toContain("## Next steps");
  });
});
