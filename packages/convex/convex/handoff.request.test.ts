import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { HANDOFF_SCAN_LIMIT, handoffBriefInput, handoffBriefRequest, shapeHandoffTranscript } from "./handoff";
import { captureFetch, goldenBody, loadGolden, recordGolden, type GoldenCase } from "./__golden__/golden.testkit";

// The body `cast handoff` posts for its brief, recorded from the code before
// handoffBriefRequest existed, by running handoff.start (dry run) over
// synthetic sessions under convex-test with fetch stubbed. The evals replay
// that builder, so these bytes are what a handoff freeze measures.

const S0 = 1_760_000_000_000;
const TOKEN = "h".repeat(64);

type Row = {
  role: "user" | "assistant";
  content?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string }>;
};

export const handoffFixtures: Array<{
  name: string;
  conversation: { title?: string; agent_type: string; model?: string; thread_state?: string };
  task?: string;
  plan?: string;
  rows: Row[];
}> = [
  {
    name: "short-session",
    conversation: { title: "Fix the flaky login test", agent_type: "claude_code" },
    rows: [
      { role: "user", content: "The login test fails one run in ten. Find out why." },
      { role: "assistant", content: "", tool_calls: [{ id: "b1", name: "Bash", input: "{\"command\":\"bun test login\"}" }] },
      { role: "user", tool_results: [{ tool_use_id: "b1", content: "1 fail: timeout waiting for #submit" }] },
      { role: "assistant", content: "The test clicks submit before the form hydrates. I added a wait for the hydrated marker; 50 runs pass." },
      { role: "user", content: "Good. Leave the CI retry setting alone." },
    ],
  },
  {
    name: "long-session-bound",
    conversation: { title: "Migrate billing to the new ledger", agent_type: "codex", model: "gpt-5", thread_state: "Migrating billing writes\nStatus: reads switched, writes half done\nNext: port refunds" },
    task: "ct-101",
    plan: "pl-7",
    rows: [
      ...Array.from({ length: 70 }, (_, i): Row =>
        i % 5 === 4
          ? { role: "user", tool_results: [{ tool_use_id: `r${i}`, content: "ok" }] }
          : { role: i % 2 ? "assistant" : "user", content: `Turn ${i}: ported ledger call ${i} and checked the totals match. ${"Detail about the ledger row shape. ".repeat(8)}` }),
      { role: "assistant", content: `Writes are half ported. ${"The refund path still writes the old table; ".repeat(200)}Next is refunds.` },
    ],
  },
  {
    name: "no-title",
    conversation: { agent_type: "gemini" },
    rows: [
      { role: "user", content: "Draft release notes for 1.4" },
      { role: "assistant", content: "Drafted notes covering the search rewrite and the offline cache." },
    ],
  },
];

describe("handoff request golden", () => {
  const fetchStub = captureFetch("## Goal\nContinue.\n\n## Next steps\n1. Run the tests.");
  beforeEach(() => fetchStub.install());
  afterEach(() => fetchStub.restore());

  test("handoff.start posts the recorded brief body for each fixture", async () => {
    const actual: GoldenCase[] = [];
    for (const fx of handoffFixtures) {
      const t = convexTest(schema, {
        "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
        "./handoff.ts": () => import("./handoff"),
      });
      const conversation_id = await t.run(async (ctx) => {
        const user_id = await ctx.db.insert("users", { name: "Fixture" } as any);
        await ctx.db.insert("api_tokens", { user_id, token_hash: await hashToken(TOKEN), name: "cli", created_at: S0, last_used_at: S0 } as any);
        const task = fx.task ? await ctx.db.insert("tasks", { user_id, short_id: fx.task, title: "Ledger", status: "in_progress", created_at: S0, updated_at: S0 } as any) : undefined;
        const plan = fx.plan ? await ctx.db.insert("plans", { user_id, short_id: fx.plan, title: "Ledger", status: "active", created_at: S0, updated_at: S0 } as any) : undefined;
        const id = await ctx.db.insert("conversations", {
          user_id, session_id: `s-${fx.name}`, short_id: `src${fx.name.length}ab`, started_at: S0, updated_at: S0,
          message_count: fx.rows.length, is_private: true, status: "active", ...fx.conversation,
          ...(task ? { active_task_id: task } : {}), ...(plan ? { active_plan_id: plan } : {}),
        } as any);
        for (const [i, row] of fx.rows.entries()) await ctx.db.insert("messages", { conversation_id: id, timestamp: S0 + i * 1000, ...row } as any);
        return id;
      });
      fetchStub.bodies.length = 0;
      await t.action(api.handoff.start, { api_token: TOKEN, conversation_id: String(conversation_id), dry_run: true });
      expect(fetchStub.bodies.length).toBe(1);
      actual.push({ case: fx.name, body: fetchStub.bodies[0] });
    }
    expect(actual).toEqual(recordGolden("handoff", actual));
  });
});

// The evals hold rows and the source's facts, not a database: the same rows
// shaped the same way through the builders must post the bytes start posts.
describe("handoff request from rows", () => {
  test("handoffBriefRequest(handoffBriefInput(facts, shapeHandoffTranscript(rows))) equals the golden", () => {
    const golden = loadGolden("handoff");
    for (const fx of handoffFixtures) {
      const newestFirst = [...fx.rows].reverse().slice(0, HANDOFF_SCAN_LIMIT);
      const input = handoffBriefInput({
        title: fx.conversation.title ?? null,
        agent_type: fx.conversation.agent_type,
        model: fx.conversation.model ?? null,
        thread_state: fx.conversation.thread_state ?? null,
        task_short_id: fx.task ?? null,
        plan_short_id: fx.plan ?? null,
      }, shapeHandoffTranscript(newestFirst));
      expect(goldenBody(handoffBriefRequest(input))).toBe(golden.find((g) => g.case === fx.name)!.body);
    }
  });
});
