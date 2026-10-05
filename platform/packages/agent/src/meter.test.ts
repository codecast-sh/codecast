import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { affordableOutputTokens, FALLBACK_PRICE, messageCost, PRICE_OVERRIDES, priceFor, usageCost } from "./meter";
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

  it("keeps pi-ai's cost when it reported one", () => {
    const message = { ...fauxAssistantMessage("hi"), usage: { ...fauxAssistantMessage("hi").usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } };
    expect(messageCost(message)).toBe(0.5);
  });

  it("buys output tokens with what is left after input", () => {
    const price = PRICE_OVERRIDES["claude-sonnet-5-5"];
    expect(affordableOutputTokens(0.01, 0, price)).toBe(1000);
    expect(affordableOutputTokens(0.01, 0.02, price)).toBe(0);
    expect(affordableOutputTokens(Number.POSITIVE_INFINITY, 1, price)).toBe(Number.POSITIVE_INFINITY);
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

  it("refuses an id that is not a Claude model", () => {
    expect(() => resolveModel("gpt-9")).toThrow();
  });
});
