import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { captureFetch, goldenBody, recordGolden, loadGolden, type GoldenCase } from "./__golden__/golden.testkit";
import { buildSettlePrompt, parseSettleReply, parseSettleVerdict, settleRequest, shapeFinalMessage, shapeSettleTail, SETTLE_FINAL_HEAD_CHARS, SETTLE_FINAL_TAIL_CHARS, SETTLE_CONTEXT_CHARS, SETTLE_TAIL_MESSAGES } from "./idleSummary";

// The settle classifier's pure half. What the model is asked, and how its
// answer is read, must be stable: the settle eval (`./evals check settle`)
// grades the live model against the same builder.
describe("shapeSettleTail", () => {
  const rows = (turns: Array<[string, string]>) => turns.map(([role, content]) => ({ role, content })).reverse();

  test("marks the last assistant message as FINAL and keeps its END", () => {
    const long = "opening. " + "middle filler. ".repeat(600) + "So the standup question is: ship B alone or B+A?";
    const out = shapeSettleTail(rows([["user", "explain"], ["assistant", long]]));
    const fin = out.find((m) => m.isFinal)!;
    expect(fin.content.endsWith("ship B alone or B+A?")).toBe(true);
    expect(fin.content.startsWith("opening.")).toBe(true);
    expect(fin.content).toContain("chars omitted");
    expect(fin.content.length).toBeLessThanOrEqual(SETTLE_FINAL_HEAD_CHARS + SETTLE_FINAL_TAIL_CHARS + 60);
  });

  test("earlier messages are context-trimmed; a trailing user message does not steal FINAL", () => {
    const out = shapeSettleTail(rows([["assistant", "a".repeat(2000)], ["user", "<session-message>ok</session-message>"]]));
    expect(out[0].isFinal).toBe(true);
    expect(out[0].content.length).toBeLessThanOrEqual(SETTLE_FINAL_HEAD_CHARS + SETTLE_FINAL_TAIL_CHARS);
    expect(out[1].isFinal).toBe(false);
    // Only the final assistant message keeps its length; a non-final one is trimmed.
    const two = shapeSettleTail(rows([["assistant", "b".repeat(2000)], ["assistant", "final"]]));
    expect(two[0].content.length).toBe(SETTLE_CONTEXT_CHARS);
    expect(two[1].isFinal).toBe(true);
  });

  test("bulky blocks collapse to markers", () => {
    expect(shapeFinalMessage("Report:\n```cast-canvas\n<div>" + "x".repeat(5000) + "</div>\n```\nDone.")).toBe("Report:\n[canvas report]\nDone.");
  });

  test("a halted tool call after the final text adds the mid-work note — but not after a wrap-up or an external message", () => {
    const halted = shapeSettleTail([
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "user", content: "", tool_results: [{}] },
      { role: "assistant", content: "OTA is live. Now the native build:" },
    ]);
    expect(halted.some((m) => m.role === "note")).toBe(true);
    // Ended on a RESULT (cast state as the last action): settled on purpose.
    const wrapped = shapeSettleTail([
      { role: "user", content: "", tool_results: [{}] },
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "assistant", content: "Shipped it." },
    ]);
    expect(wrapped.some((m) => m.role === "note")).toBe(false);
    // A teammate shutdown arrived after the report; the halted call answered it.
    const shutdown = shapeSettleTail([
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "user", content: "<teammate-message>shutdown_request</teammate-message>" },
      { role: "assistant", content: "Report sent." },
    ]);
    expect(shutdown.some((m) => m.role === "note")).toBe(false);
  });

  test("tool-result carriers and low-signal prompts drop out", () => {
    const out = shapeSettleTail([
      { role: "user", content: "", tool_results: [{}] },
      { role: "assistant", content: "shipped it" },
    ]);
    expect(out.map((m) => m.content)).toEqual(["shipped it"]);
  });
});

describe("buildSettlePrompt / parseSettleReply", () => {
  test("labels the final message and offers only done | needs_input", () => {
    const p = buildSettlePrompt(shapeSettleTail([{ role: "assistant", content: "ok" }]));
    expect(p).toContain("[FINAL MESSAGE — the settle]: ok");
    expect(p).toContain("VERDICT: <needs_input | done>");
    expect(p).not.toMatch(/\bdormant\b/);
  });

  test("parses the two-line reply and ignores anything but the two verdicts", () => {
    expect(parseSettleReply("VERDICT: done\nSUMMARY: Shipped the fix")).toEqual({ verdict: "done", summary: "Shipped the fix" });
    expect(parseSettleReply("VERDICT: needs input\nSUMMARY: Choose an option")).toEqual({ verdict: "needs_input", summary: "Choose an option" });
    // A stale "dormant" (older prompt) is not a verdict — the row keeps its needs-input default.
    expect(parseSettleReply("VERDICT: dormant\nSUMMARY: Waiting on CI").verdict).toBeNull();
    expect(parseSettleVerdict("DONE")).toBe("done");
    // No VERDICT line: whole text is the summary, verdict null.
    expect(parseSettleReply("Deployed and verified")).toEqual({ verdict: null, summary: "Deployed and verified" });
  });
});

// ── Request golden ───────────────────────────────────────────────────────────
// The exact bodies generateIdleSummary posts, recorded from the code before
// settleRequest existed. Synthetic tails only (the repo is public), run through
// the real getMessagesForSummary query under convex-test so the 30-row window,
// the filters and the final-message shaping are all in the bytes.
const S0 = 1_760_000_000_000;
type SettleRow = {
  role: "user" | "assistant";
  content?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string }>;
};
const settleFixtures: Array<{ name: string; rows: SettleRow[] }> = [
  {
    name: "asks-a-choice",
    rows: [
      { role: "user", content: "Find out why the deploy failed" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "Bash", input: "{}" }] },
      { role: "user", tool_results: [{ tool_use_id: "a", content: "exit 1" }] },
      { role: "assistant", content: 'The deploy failed on a missing env var. Two ways forward: set it in the dashboard, or default it in code. Which do you want — "dashboard" or "code"?' },
    ],
  },
  {
    name: "long-report-past-window",
    rows: [
      ...Array.from({ length: 34 }, (_, i): SettleRow =>
        i % 3 === 2
          ? { role: "user", tool_results: [{ tool_use_id: `r${i}`, content: "ok" }] }
          : { role: i % 3 === 0 ? "user" : "assistant", content: `Turn ${i}: ${"context about the audit scope and the files read. ".repeat(10)}` }),
      { role: "user", content: "[Request interrupted by user]" },
      {
        role: "assistant",
        content: `Audit done.\n\`\`\`cast-canvas\n<div>${"cell ".repeat(400)}</div>\n\`\`\`\n${"Finding: the cache key ignores the team. ".repeat(60)}\n\`\`\`ts\n${"const x = 1;\n".repeat(60)}\`\`\`\nThree risks remain; the report lists each with a fix.`,
      },
    ],
  },
  {
    name: "halted-mid-call",
    rows: [
      { role: "user", content: "Ship the OTA and then the native build" },
      { role: "assistant", content: "OTA is live. Now the native build:" },
      { role: "assistant", content: "", tool_calls: [{ id: "b", name: "Bash", input: "{\"command\":\"eas build\"}" }] },
    ],
  },
];

describe("settle request golden", () => {
  const fetchStub = captureFetch();
  beforeEach(() => fetchStub.install());
  afterEach(() => fetchStub.restore());

  test("generateIdleSummary posts the recorded body for each fixture", async () => {
    const actual: GoldenCase[] = [];
    for (const fx of settleFixtures) {
      const t = convexTest(schema, { "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"), "./idleSummary.ts": () => import("./idleSummary") });
      const conversation_id = await t.run(async (ctx) => {
        const user_id = await ctx.db.insert("users", { name: "Fixture" } as any);
        const id = await ctx.db.insert("conversations", {
          user_id, agent_type: "claude_code", session_id: `s-${fx.name}`, started_at: S0, updated_at: S0,
          message_count: fx.rows.length, is_private: true, status: "active",
        } as any);
        for (const [i, row] of fx.rows.entries()) await ctx.db.insert("messages", { conversation_id: id, timestamp: S0 + i * 1000, ...row } as any);
        return id;
      });
      fetchStub.bodies.length = 0;
      await t.action(internal.idleSummary.generateIdleSummary, { conversation_id });
      expect(fetchStub.bodies.length).toBe(1);
      actual.push({ case: fx.name, body: fetchStub.bodies[0] });
    }
    expect(actual).toEqual(recordGolden("settle", actual));
  });
});

// The evals hold a tail, not a database: settleRequest over the same rows,
// shaped the same way, must post the bytes the action posts.
describe("settle request from rows", () => {
  test("settleRequest(shapeSettleTail(rows)) equals the golden", () => {
    const golden = loadGolden("settle");
    for (const fx of settleFixtures) {
      const newestFirst = [...fx.rows].reverse().slice(0, SETTLE_TAIL_MESSAGES);
      const body = goldenBody(settleRequest(shapeSettleTail(newestFirst)));
      expect(body).toBe(golden.find((g) => g.case === fx.name)!.body);
    }
  });
});
