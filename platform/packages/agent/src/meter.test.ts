import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import type { Context } from "@mariozechner/pi-ai";
import {
  affordableOutputTokens,
  billedUsage,
  estimateInputTokens,
  estimateTokens,
  FALLBACK_PRICE,
  IMAGE_TOKENS,
  messageCost,
  PRICE_OVERRIDES,
  priceFor,
  projectInputCost,
  usageCost,
} from "./meter";
import { resolveModel } from "./models";

const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };

describe("pricing", () => {
  it("prices the override models per million, cache reads at a tenth of input", () => {
    expect(usageCost(tokens, PRICE_OVERRIDES["claude-sonnet-5-5"])).toBeCloseTo(2 + 10 + 0.2, 10);
    expect(usageCost(tokens, PRICE_OVERRIDES["claude-opus-5-5"])).toBeCloseTo(4 + 20 + 0.4, 10);
    expect(usageCost(tokens, PRICE_OVERRIDES["claude-haiku-4-5"])).toBeCloseTo(1 + 5 + 0.1, 10);
  });

  it("finds a dated snapshot's price and never prices an unknown model at zero", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(PRICE_OVERRIDES["claude-haiku-4-5"]);
    expect(priceFor("some-new-model")).toEqual(FALLBACK_PRICE);
    expect(priceFor("x", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toEqual(FALLBACK_PRICE);
    expect(priceFor("x", { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }).input).toBe(3);
  });

  it("costs a message from its tokens when pi-ai reported zero", () => {
    const message = {
      ...fauxAssistantMessage("hi"),
      model: "claude-sonnet-5-5",
      usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, totalTokens: 6200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    expect(messageCost(message)).toBeCloseTo((1000 * 2 + 200 * 10 + 5000 * 0.2) / 1_000_000, 12);
  });

  it("prices a listed model from the table even when pi-ai reported a catalog cost", () => {
    const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9 } };
    const message = { ...fauxAssistantMessage("hi"), model: "claude-haiku-4-5-20251001", usage };
    expect(messageCost(message)).toBeCloseTo((1000 * 1 + 100 * 5) / 1_000_000, 12);
  });

  it("keeps pi-ai's cost for a model the table does not list", () => {
    const message = { ...fauxAssistantMessage("hi"), usage: { ...fauxAssistantMessage("hi").usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } };
    expect(messageCost(message)).toBe(0.5);
  });

  it("buys output tokens with what is left after input", () => {
    const price = PRICE_OVERRIDES["claude-sonnet-5-5"];
    expect(affordableOutputTokens(0.01, 0, price)).toBe(1000);
    expect(affordableOutputTokens(0.01, 0.02, price)).toBe(0);
    expect(affordableOutputTokens(Number.POSITIVE_INFINITY, 1, price)).toBe(Number.POSITIVE_INFINITY);
    // A bad amount fails closed.
    expect(affordableOutputTokens(Number.NaN, 0, price)).toBe(0);
    expect(affordableOutputTokens(undefined as unknown as number, 0, price)).toBe(0);
    expect(affordableOutputTokens(1, Number.NaN, price)).toBe(0);
    expect(affordableOutputTokens(Number.NEGATIVE_INFINITY, 0, price)).toBe(0);
  });
});

describe("input projection", () => {
  it("counts non-ASCII characters as a token each and ASCII at three characters a token", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("会議は三時")).toBe(5);
    expect(estimateTokens("привет")).toBe(6);
    expect(estimateTokens("😀")).toBe(2);
  });

  it("bills images by the image, adds the tool preamble, and prices tokens as cache writes", () => {
    const image = { type: "image" as const, data: "A".repeat(300_000), mimeType: "image/png" };
    const context: Context = { systemPrompt: "", messages: [{ role: "user", content: [image], timestamp: 0 }] };
    const tokens = estimateInputTokens(context);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKENS);
    expect(tokens).toBeLessThan(IMAGE_TOKENS + 100);
    const withTool = estimateInputTokens({ ...context, tools: [{ name: "t", description: "d", parameters: {} as never }] });
    expect(withTool - tokens).toBeGreaterThanOrEqual(600 + 50);
    const price = PRICE_OVERRIDES["claude-sonnet-5-5"];
    expect(projectInputCost(context, price)).toBeCloseTo((tokens * price.cacheWrite) / 1_000_000, 12);
  });
});

describe("resolveModel", () => {
  it("builds newer Claude models priced from the override table, with no reasoning flag", () => {
    const model = resolveModel("claude-sonnet-5-5");
    expect(model).toMatchObject({ api: "anthropic-messages", provider: "anthropic", reasoning: false });
    expect(model.cost).toEqual(PRICE_OVERRIDES["claude-sonnet-5-5"]);
  });

  it("keeps pi-ai's catalog entry for a model it knows", () => {
    const model = resolveModel("claude-haiku-4-5");
    expect(model.api).toBe("anthropic-messages");
    expect(model.cost).toEqual(PRICE_OVERRIDES["claude-haiku-4-5"]);
    expect(resolveModel("claude-sonnet-4-5").cost.input).toBe(3);
  });

  it("prices a dated catalog id from the table, the same price the meter uses", () => {
    const model = resolveModel("claude-haiku-4-5-20251001");
    expect(model.cost).toEqual(PRICE_OVERRIDES["claude-haiku-4-5"]);
    expect(model.cost).toEqual(priceFor(model.id, model));
  });

  it("refuses an id nothing has priced", () => {
    expect(() => resolveModel("gpt-9")).toThrow();
    expect(() => resolveModel("claude-imaginary-9")).toThrow(/PRICE_OVERRIDES/);
  });
});

describe("cut-off billing", () => {
  const base = () => {
    const message = fauxAssistantMessage("word ".repeat(300));
    message.model = "claude-sonnet-5-5";
    message.usage = { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return message;
  };

  it("bills a finished message at its reported usage", () => {
    const message = base();
    expect(billedUsage(message)).toBe(message.usage);
  });

  it("raises a cut-off message's output to what streamed, text, thinking and tool arguments", () => {
    for (const stopReason of ["aborted", "error"] as const) {
      const message = { ...base(), stopReason };
      message.content = [
        ...message.content,
        { type: "thinking", thinking: "x".repeat(30) },
        { type: "toolCall", id: "c", name: "send", arguments: { body: "y".repeat(30) } },
      ];
      const billed = billedUsage(message);
      expect(billed.output).toBe(estimateTokens("word ".repeat(300)) + 10 + estimateTokens(`send${JSON.stringify({ body: "y".repeat(30) })}`));
      expect(billed.totalTokens).toBe(100 + billed.output);
      expect(messageCost(message)).toBeCloseTo(usageCost(billed, PRICE_OVERRIDES["claude-sonnet-5-5"]), 12);
    }
  });

  it("keeps a reported output higher than the estimate", () => {
    const message = { ...base(), stopReason: "aborted" as const };
    message.usage = { ...message.usage, output: 5_000 };
    expect(billedUsage(message).output).toBe(5_000);
  });
});
