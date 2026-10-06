import { describe, expect, test } from "bun:test";
import { providerFault } from "./faults";

describe("providerFault", () => {
  test("an empty Anthropic account is billing", () => {
    expect(providerFault('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}')).toBe("billing");
    expect(providerFault("429 You exceeded your current quota, please check your plan and billing details.")).toBe("billing");
  });

  test("a bad or missing key is auth", () => {
    expect(providerFault('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toBe("auth");
    expect(providerFault('No API key for provider "openai" in apiKeys')).toBe("auth");
  });

  test("an overloaded or unreachable provider is unavailable", () => {
    expect(providerFault('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("unavailable");
    expect(providerFault("Connection error.")).toBe("unavailable");
    expect(providerFault("429 rate_limit_error")).toBe("unavailable");
  });

  test("anything else is not the provider's", () => {
    expect(providerFault(undefined)).toBeNull();
    expect(providerFault("The run was cancelled.")).toBeNull();
    expect(providerFault('400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1: tool_use ids must be unique"}}')).toBeNull();
  });
});

describe("resolveModel with a provider prefix", () => {
  test("an openai/ id resolves from pi's OpenAI catalog with its catalog price", async () => {
    const { resolveModel } = await import("./models");
    const model = resolveModel("openai/gpt-5-mini");
    expect(model.provider).toBe("openai");
    expect(model.api).toBe("openai-responses");
    expect(model.cost.input).toBeGreaterThan(0);
    expect(() => resolveModel("openai/not-a-model")).toThrow();
  });
});
