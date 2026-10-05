import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runAssistant } from "./index";

/** One Anthropic Messages stream answering "Hello there." */
function anthropicStream(): string {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there." } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe("the Anthropic path", () => {
  const realFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    requests = [];
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
      return new Response(anthropicStream(), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1" } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("streams a newer model through pi-ai's Anthropic provider with no temperature and metered cost", async () => {
    const texts: string[] = [];
    const result = await runAssistant({
      model: "claude-sonnet-5-5",
      system: "You help.",
      history: [{ role: "user", content: "Hi", timestamp: 1 }],
      ceilingUsd: 1,
      deadlineMs: 10_000,
      apiKeys: { anthropic: "sk-ant-test" },
      onText: (text) => {
        texts.push(text);
      },
    });

    expect(result.reason).toBe("done");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: "assistant", content: "Hello there.", model: "claude-sonnet-5-5", api_message_id: "msg_test" });
    expect(texts.at(-1)).toBe("Hello there.");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(request.body.model).toBe("claude-sonnet-5-5");
    expect(request.body.temperature).toBeUndefined();
    expect(request.body.thinking).toBeUndefined();
    expect(request.body.max_tokens).toBe(32_000);

    // $2 input, $10 output, $0.20 cache reads per million.
    expect(result.costUsd).toBeCloseTo((100 * 2 + 20 * 10 + 1000 * 0.2) / 1_000_000, 12);
    expect(result.usage).toEqual({ input: 100, output: 20, cacheRead: 1000, cacheWrite: 0 });
  });

  it("stops with error and no request when there is no API key", async () => {
    const result = await runAssistant({
      model: "claude-sonnet-5-5",
      system: "You help.",
      history: [{ role: "user", content: "Hi", timestamp: 1 }],
      ceilingUsd: 1,
      deadlineMs: 10_000,
    });
    expect(result.reason).toBe("error");
    expect(result.error).toContain("API key");
    expect(requests).toHaveLength(0);
  });
});
