import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  generateSessionInsight,
  getConversationContextForInsight,
  insightRequest,
  selectInsightContext,
} from "./sessionInsights";
import { makeFakeDb } from "./testDb";
import { captureFetch, goldenBody, recordGolden, type GoldenCase } from "./__golden__/golden.testkit";

// The insight request as prod posts it, for synthetic sessions run end to end:
// the context query over a fake db, then the action with fetch stubbed.

const T0 = Date.UTC(2026, 0, 15, 0, 5, 0);
const MIN = 60_000;

function msg(i: number, role: string, content: string, timestamp: number, tools?: string[]) {
  return {
    _id: `m${i}`,
    conversation_id: "conv1",
    role,
    content,
    timestamp,
    ...(tools ? { tool_calls: tools.map((name, k) => ({ id: `tc${i}-${k}`, name, input: "{}" })) } : {}),
  };
}

type InsightFixture = { case: string; reason?: "idle" | "manual"; tables: Record<string, any[]> };

const FIXTURES: InsightFixture[] = [
  {
    // Six rows, two of them dropped (a system row, an empty one); times on
    // both sides of noon so the clock format is pinned.
    case: "short-no-team",
    tables: {
      conversations: [{ _id: "conv1", user_id: "u1", title: "Fix the flaky login test", subtitle: "auth tests", idle_summary: "Waiting on CI", project_path: "/work/demo-app", git_branch: "main", status: "active", started_at: T0, updated_at: T0 + 47 * MIN }],
      messages: [
        msg(1, "user", "The login test fails about one run in five. Find out why.", T0),
        msg(2, "system", "hook output", T0 + 1000),
        msg(3, "assistant", "Reading the test and the session fixture.", T0 + MIN, ["Read", "Grep"]),
        msg(4, "assistant", "", T0 + MIN + 1000, ["Bash"]),
        msg(5, "assistant", "The fixture shares a clock with the token refresh; the race shows when refresh lands mid-assert.", T0 + 822 * MIN),
        msg(6, "user", "Pin the clock in the fixture and rerun it fifty times.", T0 + 827 * MIN, ["Read"]),
      ],
      commits: [],
    },
  },
  {
    // 90 rows: the query keeps the newest 80, the prompt samples the first 8
    // and last 10, one reply is over the 500 character cut, commits and PRs
    // are capped, and a PR on another team is left out.
    case: "long-team-commits-prs",
    reason: "idle",
    tables: {
      conversations: [{ _id: "conv1", user_id: "u1", team_id: "team1", is_private: false, title: "Migrate the billing tables", subtitle: "schema move", project_path: "/work/billing", git_branch: "migrate-tables", status: "completed", started_at: T0, updated_at: T0 + 700 * MIN }],
      messages: Array.from({ length: 90 }, (_, k) => {
        const i = k + 1;
        const role = i % 3 === 0 ? "user" : "assistant";
        const content = i === 85
          ? "Long reply ".repeat(80) + "end."
          : `Step ${i}: ${role === "user" ? "please continue with the migration" : "migrated another table and ran its tests"}.`;
        return msg(i, role, content, T0 + i * 7 * MIN, i % 10 === 0 ? ["Edit", "Bash", i % 20 === 0 ? "Write" : "Read"] : undefined);
      }),
      commits: Array.from({ length: 10 }, (_, i) => ({
        _id: `c${i}`,
        conversation_id: "conv1",
        sha: `abcdef${i}0123456789`,
        message: i === 2 ? "Move invoices table\n\nLonger body that the prompt drops." : `Migrate table ${i}`,
        files_changed: i + 1,
        insertions: 10 * i,
        deletions: i,
        timestamp: T0 + i * MIN,
      })),
      pull_request_sessions: [
        { _id: "prs1", conversation_id: "conv1", pull_request_id: "pr1" },
        { _id: "prs2", conversation_id: "conv1", pull_request_id: "pr2" },
        { _id: "prs3", conversation_id: "conv1", pull_request_id: "pr3" },
      ],
      pull_requests: [
        { _id: "pr1", team_id: "team1", number: 41, title: "Move invoices", state: "merged", repository: "demo/billing", updated_at: T0 + 100 },
        { _id: "pr2", team_id: "team1", number: 42, title: "Move payments", state: "open", repository: "demo/billing", updated_at: T0 + 200 },
        { _id: "pr3", team_id: "team2", number: 7, title: "Other team", state: "open", repository: "demo/other", updated_at: T0 + 300 },
      ],
    },
  },
  {
    // Twelve rows (no sampling), no metadata, zero timestamps, quotes and
    // newlines in content, and a manual run.
    case: "sparse-twelve",
    reason: "manual",
    tables: {
      conversations: [{ _id: "conv1", user_id: "u1", status: "active", started_at: 0, updated_at: 0 }],
      messages: Array.from({ length: 12 }, (_, i) =>
        msg(i + 1, i % 2 ? "assistant" : "user", `Message ${i + 1} with "quotes" and a\nnewline.`, i === 0 ? 0 : T0 + i * 60 * MIN)),
      commits: [],
    },
  },
];

/** Run the query and the action over the fixture; the bodies the action posted. */
async function runInsight(fixture: InsightFixture, capture: ReturnType<typeof captureFetch>) {
  const db = makeFakeDb(structuredClone(fixture.tables));
  const ctx = {
    runQuery: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "sessionInsights:getConversationContextForInsight") {
        return (getConversationContextForInsight as any)._handler({ db }, args);
      }
      if (name === "sessionInsights:getExistingInsight") return null;
      throw new Error(`unexpected query ${name}`);
    },
    runMutation: async () => "insight1",
    scheduler: { runAfter: async () => {} },
  };
  const before = capture.bodies.length;
  const res = await (generateSessionInsight as any)._handler(ctx, {
    conversation_id: "conv1",
    ...(fixture.reason ? { reason: fixture.reason } : {}),
  });
  expect(res.status).toBe("ok");
  return capture.bodies.slice(before);
}

describe("insight request goldens", () => {
  const capture = captureFetch('{"headline":"h","summary":"s","themes":["x"]}');
  beforeEach(() => capture.install());
  afterEach(() => capture.restore());

  test("the action posts the recorded body for every fixture", async () => {
    const actual: GoldenCase[] = [];
    for (const fixture of FIXTURES) {
      const bodies = await runInsight(fixture, capture);
      expect(bodies).toHaveLength(1);
      actual.push({ case: fixture.case, body: bodies[0]! });
    }
    expect(actual).toEqual(recordGolden("insight", actual));
  });

  test("the shared builders render the same body from the same facts", async () => {
    const actual: GoldenCase[] = [];
    for (const fixture of FIXTURES) {
      const db = makeFakeDb(structuredClone(fixture.tables));
      const context = await (getConversationContextForInsight as any)._handler({ db }, { conversation_id: "conv1" });
      actual.push({ case: fixture.case, body: goldenBody(insightRequest(context, fixture.reason ?? "periodic")) });
    }
    expect(actual).toEqual(recordGolden("insight", actual));
  });

  test("the selector over the newest 80 rows is what the query hands the prompt", async () => {
    for (const fixture of FIXTURES) {
      const db = makeFakeDb(structuredClone(fixture.tables));
      const context = await (getConversationContextForInsight as any)._handler({ db }, { conversation_id: "conv1" });
      const rows = [...fixture.tables.messages!].sort((a, b) => a.timestamp - b.timestamp).slice(-80);
      expect(selectInsightContext(rows)).toEqual({ messages: context.messages, tool_names: context.tool_names });
    }
  });

  test("message times print in UTC whatever the machine's zone", () => {
    const at = Date.UTC(2026, 0, 15, 23, 30);
    const req = insightRequest(
      { conversation: { status: "active", started_at: 0, updated_at: 0 }, messages: [{ role: "user", content: "hi", timestamp: at }], tool_names: [], commits: [], prs: [] },
      "periodic",
    );
    expect(req.prompt.endsWith("[23:30] User: hi")).toBe(true);
    expect(req.temperature).toBeUndefined();
  });
});
