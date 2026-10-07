import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { anthropicBody, callModel, CHEAP_MODEL, type SurfaceRequest } from "./anthropic";

// Bodies recorded from callModel before it built them through anthropicBody.
// Byte identity with these strings is the contract: the evals replay
// anthropicBody, so any drift here means the evals measure a prompt prod
// never sends.
const CASES: Array<{ args: Parameters<typeof callModel>[0]; request: SurfaceRequest; golden: string }> = [
  {
    args: { prompt: 'Name this session.\nLine two with "quotes".', max_tokens: 200, label: "a" },
    request: { model: CHEAP_MODEL, prompt: 'Name this session.\nLine two with "quotes".', max_tokens: 200, temperature: 0 },
    golden:
      '{"model":"claude-haiku-4-5-20251001","max_tokens":200,"temperature":0,"messages":[{"role":"user","content":"Name this session.\\nLine two with \\"quotes\\"."}]}',
  },
  {
    args: { prompt: "Answer from the sessions.", system: "You answer questions.", max_tokens: 1500, model: "claude-sonnet-5-5", label: "b" },
    // Sonnet 5.5 refuses any temperature, so callModel defaults it only for the cheap model.
    request: { model: "claude-sonnet-5-5", system: "You answer questions.", prompt: "Answer from the sessions.", max_tokens: 1500 },
    golden:
      '{"model":"claude-sonnet-5-5","max_tokens":1500,"system":"You answer questions.","messages":[{"role":"user","content":"Answer from the sessions."}]}',
  },
  {
    args: { prompt: "Brief the next session.", system: "", max_tokens: 1200, temperature: 0.3, label: "c" },
    request: { model: CHEAP_MODEL, system: "", prompt: "Brief the next session.", max_tokens: 1200, temperature: 0.3 },
    golden:
      '{"model":"claude-haiku-4-5-20251001","max_tokens":1200,"temperature":0.3,"messages":[{"role":"user","content":"Brief the next session."}]}',
  },
];

describe("anthropicBody", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  let sent: string[];

  beforeEach(() => {
    sent = [];
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      sent.push(init.body);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });

  for (const [i, c] of CASES.entries()) {
    test(`case ${i + 1}: callModel still sends the recorded body`, async () => {
      expect(await callModel(c.args)).not.toBeNull();
      expect(sent).toEqual([c.golden]);
    });

    test(`case ${i + 1}: anthropicBody stringifies to the recorded body`, () => {
      expect(JSON.stringify(anthropicBody(c.request))).toBe(c.golden);
    });
  }

  test("an undefined temperature is left out, so the API default applies", () => {
    // The shape the insight and call summary sites post today.
    expect(JSON.stringify(anthropicBody({ model: CHEAP_MODEL, prompt: "p", max_tokens: 1200 }))).toBe(
      '{"model":"claude-haiku-4-5-20251001","max_tokens":1200,"messages":[{"role":"user","content":"p"}]}',
    );
  });
});
