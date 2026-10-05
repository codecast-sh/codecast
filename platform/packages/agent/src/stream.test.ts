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
    expect(texts[texts.length - 1]).toBe("Hello there.");

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

  const ask = (ceilingUsd: number, model: string, reasoning: "high" | "xhigh") =>
    runAssistant({
      model,
      system: "You help.",
      history: [{ role: "user", content: "Hi", timestamp: 1 }],
      ceilingUsd,
      deadlineMs: 10_000,
      apiKeys: { anthropic: "sk-ant-test" },
      reasoning,
    });

  it("keeps a thinking budget inside the cap the money left buys", async () => {
    // claude-haiku-4-5 declares reasoning, so pi sends a budget and adds it on top of the cap it is given.
    await ask(0.02, "claude-haiku-4-5", "high");
    const body = requests[0].body as { max_tokens: number; thinking?: { type: string; budget_tokens: number } };
    expect(body.thinking?.type).toBe("enabled");
    expect(body.thinking!.budget_tokens).toBeGreaterThanOrEqual(1_024);
    expect(body.thinking!.budget_tokens).toBeLessThan(body.max_tokens);
    // $5 a million output: $0.02 buys 4,000 tokens, less the input.
    expect(body.max_tokens).toBeLessThanOrEqual(4_000);
    expect(body.max_tokens).toBeGreaterThan(3_000);
  });

  it("drops a thinking budget the money left cannot fit beside an answer", async () => {
    await ask(0.01, "claude-haiku-4-5", "xhigh"); // under 2,000 tokens: not 1,024 of thinking plus 1,024 of answer
    const body = requests[0].body as { max_tokens: number; thinking?: { type: string } };
    expect(body.thinking?.type).not.toBe("enabled");
    expect(body.max_tokens).toBeLessThanOrEqual(2_000);
  });

  it("ignores reasoning on a table-built model, which takes no budget, and never inflates its cap", async () => {
    await ask(0.02, "claude-sonnet-5-5", "high");
    const body = requests[0].body as { max_tokens: number; thinking?: unknown };
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBeLessThanOrEqual(2_000); // $10 a million output
  });

  it("stops with error and never uses the env key when apiKeys lacks the provider", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const result = await runAssistant({
      model: "claude-sonnet-5-5",
      system: "You help.",
      history: [{ role: "user", content: "Hi", timestamp: 1 }],
      ceilingUsd: 1,
      deadlineMs: 10_000,
      apiKeys: { openai: "sk-other" },
    });
    delete process.env.ANTHROPIC_API_KEY;
    expect(result.reason).toBe("error");
    expect(result.error).toContain("anthropic");
    expect(requests).toHaveLength(0);
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
