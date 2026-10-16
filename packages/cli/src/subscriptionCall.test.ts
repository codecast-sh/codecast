// A judge call on a subscription (subscriptionCall.ts): the child never sees a
// model key that would bill the API ahead of the login, and the reply read
// from claude's stream is the first one, as the API call gets it.
import { describe, expect, test } from "bun:test";
import { callArgs, firstReply, isolatedEnv } from "./subscriptionCall.js";

describe("the child environment", () => {
  test("strips every model route the shell carries when asked, and keeps the rest", () => {
    const saved = { ...process.env };
    Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://proxy", OPENROUTER_API_KEY: "or-x", OPENAI_API_KEY: "oa-x", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "p", CODECAST_SESSION_ID: "jx1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "99", KEEP_ME: "yes" });
    try {
      const env = isolatedEnv({ configDir: "/tmp/cfg", token: "tok", stripModelKeys: true, maxOutputTokens: 16000 });
      for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "CODECAST_SESSION_ID"]) expect(env[k]).toBeUndefined();
      expect(env).toMatchObject({ KEEP_ME: "yes", CLAUDE_CONFIG_DIR: "/tmp/cfg", CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16000" });
      // An agent dry run keeps the shell's keys: what it replays may need them.
      expect(isolatedEnv({ configDir: "/tmp/cfg", token: "tok", stripModelKeys: false }).OPENROUTER_API_KEY).toBe("or-x");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test("a call is one turn with no tools, the given system prompt and effort", () => {
    const args = callArgs({ model: "claude-sonnet-5-5", systemFile: "/r/system.txt", effort: "high" });
    expect(args.join(" ")).toContain("-p --tools  --system-prompt-file /r/system.txt --strict-mcp-config --disable-slash-commands --max-turns 1 --model claude-sonnet-5-5 --effort high");
  });
});

describe("reading the stream", () => {
  const ev = (event: unknown) => JSON.stringify({ type: "stream_event", event });
  test("the first reply's text, stop reason and usage; thinking noticed; a resumed second reply ignored", () => {
    const stream = [
      ev({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }),
      ev({ type: "content_block_start", content_block: { type: "thinking" } }),
      ev({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
      ev({ type: "content_block_delta", delta: { type: "text_delta", text: '{"deviations": ' } }),
      ev({ type: "content_block_delta", delta: { type: "text_delta", text: "[]}" } }),
      ev({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 40 } }),
      ev({ type: "message_start", message: { usage: { input_tokens: 11 } } }),
      ev({ type: "content_block_delta", delta: { type: "text_delta", text: "more" } }),
      JSON.stringify({ type: "result", total_cost_usd: 0.01, is_error: true }),
      "{partial",
    ].join("\n");
    const { reply, result, thought } = firstReply(stream);
    expect(reply).toEqual({ text: '{"deviations": []}', stop_reason: "max_tokens", usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 40 } });
    expect(thought).toBe(true);
    expect(result.total_cost_usd).toBe(0.01);
  });
});
