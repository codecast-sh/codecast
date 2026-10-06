import { describe, expect, test } from "bun:test";
import { parseInsightReply, selectInsightContext } from "./sessionInsights";
import { consolidateProjectMemory, foldProjectMemory, PROJECT_MEMORY_MAX_ROWS } from "./projectMemory";
import { listDecisionsForViewer } from "./decisions";
import { makeFakeDb } from "./testDb";

const DAY = 24 * 60 * 60 * 1000;
const conv = (n: number) => `conv${n}` as any;

describe("insight reply: corrections and decisions", () => {
  test("the parser keeps well formed pairs and drops the rest", () => {
    const reply = parseInsightReply(JSON.stringify({
      summary: "s",
      outcome_type: "progress",
      themes: ["x"],
      corrections: [
        { said: "stop rewriting files you do not own", instead: "Only edit files this task names" },
        { said: "", instead: "dropped: empty said" },
        { said: "no instead" },
        "not an object",
      ],
      decisions: [{ title: "Use Convex for the backend", why: "typed end to end" }, { title: "no why" }],
    }));
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.corrections).toEqual([{ said: "stop rewriting files you do not own", instead: "Only edit files this task names" }]);
    expect(reply.decisions).toEqual([{ title: "Use Convex for the backend", why: "typed end to end" }]);
  });

  test("a reply without the arrays parses as before", () => {
    const reply = parseInsightReply(JSON.stringify({ summary: "s", outcome_type: "shipped", themes: [] }));
    expect(reply.ok && reply.corrections).toBeUndefined();
    expect(reply.ok && reply.decisions).toBeUndefined();
  });

  test("sampling a long session keeps a redirecting user turn from the cut middle", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: i === 12 ? "No, don't touch the schema, do it in the CLI instead" : `turn ${i}`,
      timestamp: i,
    }));
    const { messages } = selectInsightContext(rows);
    expect(messages.length).toBe(19);
    expect(messages.map((m) => m.timestamp)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 12, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    // An assistant turn with the same words is not a redirect.
    rows[12].role = "assistant";
    expect(selectInsightContext(rows).messages.length).toBe(18);
  });
});

describe("foldProjectMemory", () => {
  test("dedupes by token overlap, counts, and promotes at 2 sessions or 3 sightings", () => {
    const first = foldProjectMemory([], [{ kind: "correction", text: "Run the typecheck with cast check, never tsc", detail: "no tsc" }], conv(1), 1000);
    expect(first.rows.length).toBe(1);
    expect(first.rows[0].promoted).toBe(false);
    const second = foldProjectMemory(first.rows, [{ kind: "correction", text: "Typecheck with cast check instead of tsc" }], conv(1), 2000);
    expect(second.rows.length).toBe(1);
    expect(second.rows[0].count).toBe(2);
    expect(second.rows[0].promoted).toBe(false);
    expect(second.added).toEqual([]);
    const third = foldProjectMemory(second.rows, [{ kind: "correction", text: "Typecheck with cast check, not tsc" }], conv(1), 3000);
    expect(third.rows[0].count).toBe(3);
    expect(third.rows[0].promoted).toBe(true);
    const other = foldProjectMemory(first.rows, [{ kind: "correction", text: "Use cast check for the typecheck, never tsc" }], conv(2), 2000);
    expect(other.rows[0].conversation_ids).toEqual([conv(1), conv(2)]);
    expect(other.rows[0].promoted).toBe(true);
    // Same words, different kind: a decision does not fold into a correction.
    const mixed = foldProjectMemory(first.rows, [{ kind: "decision", text: "Run the typecheck with cast check, never tsc" }], conv(1), 2000);
    expect(mixed.rows.length).toBe(2);
  });

  test("caps rows at the top 20 by count then recency and ages out 90 day old rows", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      kind: "decision" as const,
      text: `decision number ${i} about topic${i}`,
      count: i < 5 ? 1 : 2,
      first_seen: 0,
      last_seen: i === 24 ? 0 : 100 * DAY - 1000 + i,
      conversation_ids: [conv(1)],
      promoted: false,
    }));
    const { rows: kept } = foldProjectMemory(rows, [], conv(1), 100 * DAY);
    expect(kept.length).toBe(PROJECT_MEMORY_MAX_ROWS);
    expect(kept.some((r) => r.text.includes("number 24"))).toBe(false); // aged out
    // 19 count-2 rows survive the age cut; the one remaining slot goes to the most recent count-1 row.
    expect(kept.filter((r) => r.count === 1).map((r) => r.text)).toEqual(["decision number 4 about topic4"]);
    expect(kept[0].count).toBe(2);
    expect(kept[0].last_seen).toBeGreaterThan(kept[18].last_seen);
  });
});

describe("consolidateProjectMemory", () => {
  test("writes rows under the conversation's workspace key and files decisions as automatic", async () => {
    const db = makeFakeDb({
      users: [{ _id: "u1", team_id: "t1" }],
      conversations: [{ _id: "conv1", user_id: "u1", team_id: "t1", project_path: "/p", is_private: false, session_id: "s1" }],
      project_memory: [],
      decisions: [],
    });
    await consolidateProjectMemory({ db }, {
      conversation_id: conv(1),
      team_id: "t1" as any,
      user_id: "u1" as any,
      corrections: [{ said: "stop", instead: "Edit only named files" }],
      decisions: [{ title: "Keep history flat", why: "rebase never merge" }],
      now: 5000,
    });
    const memory = db._inserted.filter((r) => r.table === "project_memory").map((r) => r.doc);
    expect(memory.length).toBe(2);
    expect(memory.every((r) => r.workspace === "team:t1" && r.project_path === "/p")).toBe(true);
    const decision = db._inserted.find((r) => r.table === "decisions")?.doc;
    expect(decision).toMatchObject({ title: "Keep history flat", rationale: "rebase never merge", source: "automatic", workspace: "team:t1", project_path: "/p" });
  });
});

describe("listDecisionsForViewer", () => {
  const tables = () => ({
    users: [{ _id: "u1" }, { _id: "u2" }],
    team_memberships: [{ _id: "m1", user_id: "u1", team_id: "t1" }, { _id: "m2", user_id: "u2", team_id: "t1" }],
    decisions: [
      { _id: "d1", user_id: "u1", workspace: "team:t1", project_path: "/p", title: "Use Convex", rationale: "r", created_at: 1 },
      { _id: "d2", user_id: "u2", workspace: "team:t1", project_path: "/q", title: "Use Vite", rationale: "r", created_at: 2 },
      { _id: "d3", user_id: "u2", workspace: "user:u2", project_path: "/p", title: "Use Bun privately", rationale: "r", created_at: 3 },
      { _id: "d4", user_id: "u3", workspace: "team:t9", project_path: "/p", title: "Use Deno elsewhere", rationale: "r", created_at: 4 },
    ],
  });

  test("a teammate reads the team's decisions, not a teammate's private ones or another team's", async () => {
    const db = makeFakeDb(tables());
    const rows = await listDecisionsForViewer({ db }, "u1" as any, { limit: 20, offset: 0 });
    expect(rows.map((d) => d._id)).toEqual(["d2", "d1"]);
    const mine = await listDecisionsForViewer({ db }, "u2" as any, { limit: 20, offset: 0 });
    expect(mine.map((d) => d._id)).toEqual(["d3", "d2", "d1"]);
  });

  test("a project filter and a search keep the same access rule", async () => {
    const db = makeFakeDb(tables());
    const byProject = await listDecisionsForViewer({ db }, "u1" as any, { project_path: "/p", limit: 20, offset: 0 });
    expect(byProject.map((d) => d._id)).toEqual(["d1"]);
    const searched = await listDecisionsForViewer({ db }, "u1" as any, { search: "Use", limit: 20, offset: 0 });
    expect(searched.map((d) => d._id).sort()).toEqual(["d1", "d2"]);
  });
});
