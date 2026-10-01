import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { askAnswerRequest, askTerms, askTermsRequest, readRows } from "./lib/sessionAsk";
import { captureFetch, goldenBody, loadGolden, recordGolden, type GoldenCase } from "./__golden__/golden.testkit";

// The two bodies `cast read <id> --ask` posts (the terms call, then the
// answer), recorded from the code before askTermsRequest and askAnswerRequest
// existed, by running the real action over synthetic sessions under
// convex-test with fetch stubbed. The evals replay those builders, so these
// bytes are what an ask freeze measures.

const S0 = 1_760_000_000_000;
const TOKEN = "a".repeat(64);
// Both calls get this reply: the terms call parses it as extra terms, so the
// model's expansion reaches the scan and the second prompt.
const REPLY = '["MAX_RETRIES", "retry cap", "backoff"]';

type Row = {
  role: "user" | "assistant";
  content?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
};

export const askFixtures: Array<{ name: string; title: string; question: string; rows: Row[] }> = [
  {
    name: "revised-decision",
    title: "Tune the sync retry loop",
    question: "Did we keep the retry cap at 5?",
    rows: [
      { role: "user", content: "The sync loop retries forever on a 500. Cap it." },
      { role: "assistant", content: "I'll cap retries with MAX_RETRIES = 5 and exponential backoff." },
      { role: "assistant", content: "", tool_calls: [{ id: "e1", name: "Edit", input: JSON.stringify({ file_path: "/repo/src/sync.ts", old_string: "while (true)", new_string: "for (let i = 0; i < MAX_RETRIES; i++)" }) }] },
      { role: "user", tool_results: [{ tool_use_id: "e1", content: "The file /repo/src/sync.ts has been updated." }] },
      { role: "user", content: "5 is too low for flaky mobile links, make it 8 and keep the backoff." },
      { role: "assistant", content: "Raised MAX_RETRIES to 8; backoff unchanged. Tests pass." },
    ],
  },
  {
    name: "tool-error",
    title: "Deploy the web build",
    question: "Why did the deploy fail?",
    rows: [
      { role: "user", content: "Deploy the web build to staging." },
      { role: "assistant", content: "", tool_calls: [{ id: "b1", name: "Bash", input: JSON.stringify({ command: "bun run deploy:staging" }) }] },
      { role: "user", tool_results: [{ tool_use_id: "b1", content: "Error: STAGING_TOKEN is not set\nexit 1", is_error: true }] },
      { role: "assistant", content: "The deploy failed because STAGING_TOKEN is missing from the environment." },
      { role: "user", content: "It is in the vault now, try again." },
      { role: "assistant", content: "", tool_calls: [{ id: "b2", name: "Bash", input: JSON.stringify({ command: "bun run deploy:staging" }) }] },
      { role: "user", tool_results: [{ tool_use_id: "b2", content: "Deployed to staging in 41s" }] },
      { role: "assistant", content: "Deployed to staging." },
    ],
  },
  {
    name: "not-found",
    title: "Rename the settings page",
    question: "Which Redis eviction policy was chosen?",
    rows: [
      ...Array.from({ length: 30 }, (_, i): Row => ({
        role: i % 2 ? "assistant" : "user",
        content: i % 2 ? `Step ${i}: renamed the settings route and updated its links in the nav.` : `Next: check page ${i} still renders after the rename.`,
      })),
      { role: "assistant", content: "Summary: the settings page is now Preferences everywhere." },
    ],
  },
];

describe("ask request golden", () => {
  const fetchStub = captureFetch(REPLY);
  beforeEach(() => fetchStub.install());
  afterEach(() => fetchStub.restore());

  test("the ask action posts the recorded terms and answer bodies", async () => {
    const actual: GoldenCase[] = [];
    for (const fx of askFixtures) {
      const t = convexTest(schema, {
        "./_generated/server.ts": () => import("./_generated/server"),
        "./sessionAsk.ts": () => import("./sessionAsk"),
        "./ipRateLimit.ts": () => import("./ipRateLimit"),
      });
      const conversation_id = await t.run(async (ctx) => {
        const user_id = await ctx.db.insert("users", { name: "Fixture" } as any);
        await ctx.db.insert("api_tokens", { user_id, token_hash: await hashToken(TOKEN), name: "cli", created_at: S0, last_used_at: S0 } as any);
        const id = await ctx.db.insert("conversations", {
          user_id, agent_type: "claude_code", session_id: `s-${fx.name}`, started_at: S0, updated_at: S0, title: fx.title,
          message_count: fx.rows.length, is_private: true, status: "active",
        } as any);
        for (const [i, row] of fx.rows.entries()) await ctx.db.insert("messages", { conversation_id: id, timestamp: S0 + i * 1000, ...row } as any);
        return id;
      });
      fetchStub.bodies.length = 0;
      await t.action(internal.sessionAsk.ask, { api_token: TOKEN, conversation_id: String(conversation_id), question: fx.question });
      expect(fetchStub.bodies.length).toBe(2);
      actual.push({ case: `${fx.name}:terms`, body: fetchStub.bodies[0] }, { case: `${fx.name}:answer`, body: fetchStub.bodies[1] });
    }
    expect(actual).toEqual(recordGolden("ask", actual));
  });
});

// The evals hold rows, not a database: the same rows through readRows and the
// two builders must post the bytes the action posts.
describe("ask requests from rows", () => {
  test("askTermsRequest, readRows and askAnswerRequest equal the golden", async () => {
    const golden = loadGolden("ask");
    const body = (name: string) => golden.find((g) => g.case === name)!.body;
    for (const fx of askFixtures) {
      expect(goldenBody(askTermsRequest(fx.question))).toBe(body(`${fx.name}:terms`));
      const terms = askTerms(fx.question, REPLY);
      const rows = fx.rows.map((r, i) => ({ _id: `m${i}`, timestamp: S0 + i * 1000, ...r }));
      const read = await readRows(rows, terms);
      expect(read.complete).toBe(true);
      const { request } = askAnswerRequest({ question: fx.question, title: fx.title, read, termCount: terms.length });
      expect(goldenBody(request)).toBe(body(`${fx.name}:answer`));
    }
  });
});
