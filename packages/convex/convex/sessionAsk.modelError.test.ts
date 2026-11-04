// `cast read <id> --ask` answered "The model did not answer; retry in a
// moment" on every session for an evening (2026-11-03, from about 15:45 UTC
// until some time before 03:00 UTC the next day), each in under two seconds: the
// Messages API was refusing the calls, and the reason it gave went only to the
// deployment's log. The person asking could not tell an outage they should
// wait out from a refusal someone has to fix. The error now carries it.
import { afterEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { hashToken } from "./apiTokens";

const S0 = 1_760_000_000_000;
const TOKEN = "b".repeat(64);
const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

async function askWith(respond: () => Response): Promise<unknown> {
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./syncOutbox.ts": () => import("./syncOutbox"),
    "./sessionAsk.ts": () => import("./sessionAsk"),
    "./ipRateLimit.ts": () => import("./ipRateLimit"),
  });
  const conversation_id = await t.run(async (ctx) => {
    const user_id = await ctx.db.insert("users", { name: "Fixture" } as any);
    await ctx.db.insert("api_tokens", { user_id, token_hash: await hashToken(TOKEN), name: "cli", created_at: S0, last_used_at: S0 } as any);
    const id = await ctx.db.insert("conversations", {
      user_id, agent_type: "claude_code", session_id: "s-model-error", started_at: S0, updated_at: S0, title: "Short session",
      message_count: 2, is_private: true, status: "active",
    } as any);
    await ctx.db.insert("messages", { conversation_id: id, timestamp: S0, role: "user", content: "Cap the retries at 5." } as any);
    await ctx.db.insert("messages", { conversation_id: id, timestamp: S0 + 1000, role: "assistant", content: "Capped at 5." } as any);
    return id;
  });
  return t.action(internal.sessionAsk.ask, { api_token: TOKEN, conversation_id: String(conversation_id), question: "What is the cap?" })
    .then(() => "answered", (err: unknown) => (err instanceof Error ? err.message : String(err)));
}

describe("a model call the API refuses", () => {
  test("names the API's answer", async () => {
    const message = await askWith(() => new Response(
      JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      { status: 529 },
    ));
    expect(message).toContain("The model did not answer");
    expect(message).toContain("the model API answered 529: Overloaded");
  });

  test("names an empty reply's stop reason", async () => {
    const message = await askWith(() => new Response(JSON.stringify({
      type: "message", role: "assistant", content: [], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 },
    })));
    expect(message).toContain("the model gave no answer (stopped: max_tokens)");
  });
});
