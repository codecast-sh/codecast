import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type Context,
  type FauxProviderRegistration,
  type Message,
  type StreamOptions,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { defineTool, DEFAULT_MAX_TOKENS, MIN_OUTPUT_TOKENS, runAssistant, Type, type MessageRow, type RunAssistantOptions } from "./index";

let faux: FauxProviderRegistration;

beforeEach(() => {
  // The faux model reports zero cost, so these runs are metered from the override table.
  faux = registerFauxProvider({ models: [{ id: "claude-sonnet-5-5" }] });
});

afterEach(() => faux.unregister());

const ask = (text: string): MessageRow => ({ role: "user", content: text, timestamp: 1 });

/** Tools that record what they were called with. */
function tools() {
  const calls = { lookup: [] as string[], send: [] as string[] };
  const lookup = defineTool({
    name: "lookup",
    description: "Looks something up.",
    parameters: Type.Object({ q: Type.String() }),
    risk: "read",
    run: ({ q }) => {
      calls.lookup.push(q);
      return `found ${q}`;
    },
  });
  const send = defineTool({
    name: "send_email",
    description: "Sends an email.",
    parameters: Type.Object({ to: Type.String(), body: Type.String() }),
    risk: "write",
    run: ({ to }) => {
      calls.send.push(to);
      return { content: `sent to ${to}`, details: { to } };
    },
  });
  return { calls, list: [lookup, send] };
}

function run(options: Partial<RunAssistantOptions> & Pick<RunAssistantOptions, "history">) {
  return runAssistant({ model: faux.getModel(), system: "You help.", ceilingUsd: 1, deadlineMs: 10_000, ...options });
}

/** A faux reply that also records the context and options the model was called with. */
function seeing(reply: Parameters<typeof fauxAssistantMessage>[0], into: { context?: Context; options?: StreamOptions }) {
  return (context: Context, options: StreamOptions | undefined) => {
    into.context = { ...context, messages: [...context.messages] };
    into.options = options;
    return fauxAssistantMessage(reply);
  };
}

describe("runAssistant", () => {
  it("runs the tool call loop and streams text into one row per message", async () => {
    const { calls, list } = tools();
    const seen: { context?: Context; options?: StreamOptions } = {};
    faux.setResponses([
      fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("lookup", { q: "dana" }, { id: "call_1" })], {
        stopReason: "toolUse",
      }),
      seeing("Dana is free at 3.", seen),
    ]);
    const texts: { text: string; uuid: string }[] = [];
    const finished: { row: MessageRow; cost: number }[] = [];

    const result = await run({
      history: [ask("Is Dana free?")],
      tools: list,
      onText: (text, { messageUuid }) => {
        texts.push({ text, uuid: messageUuid });
      },
      onMessage: (row, { costUsd }) => {
        finished.push({ row, cost: costUsd });
      },
    });

    expect(result.reason).toBe("done");
    expect(calls.lookup).toEqual(["dana"]);
    expect(result.messages.map((row) => row.role)).toEqual(["assistant", "user", "assistant"]);
    expect(result.messages[0]).toMatchObject({
      content: "Let me look.",
      tool_calls: [{ id: "call_1", name: "lookup", input: JSON.stringify({ q: "dana" }) }],
      model: "claude-sonnet-5-5",
    });
    expect(result.messages[1].tool_results).toEqual([{ tool_use_id: "call_1", content: "found dana", is_error: false }]);
    expect(result.messages[2].content).toBe("Dana is free at 3.");

    // The second call saw the tool's result.
    const lastSeen = seen.context!.messages.at(-1) as ToolResultMessage;
    expect(lastSeen).toMatchObject({ role: "toolResult", toolCallId: "call_1" });

    // Streaming: the final text of each message, under the uuid its finished row carries.
    const finalText = texts.filter((t) => t.uuid === result.messages[2].message_uuid).at(-1);
    expect(finalText?.text).toBe("Dana is free at 3.");
    expect(new Set(texts.map((t) => t.uuid)).size).toBe(2);
    expect(result.messages[0].api_message_id).toBeTruthy();

    // Metering: every model message costs something, and the run's cost is their sum.
    expect(finished).toHaveLength(3);
    const modelCosts = finished.filter((f) => f.row.role === "assistant").map((f) => f.cost);
    expect(modelCosts.every((cost) => cost > 0)).toBe(true);
    expect(result.costUsd).toBeCloseTo(modelCosts[0] + modelCosts[1], 12);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.output).toBeGreaterThan(0);

    // No temperature, and room for thinking in max_tokens.
    expect(seen.options?.temperature).toBeUndefined();
    expect(seen.options?.maxTokens).toBe(Math.min(faux.getModel().maxTokens, DEFAULT_MAX_TOKENS));
  });

  it("stops for approval on ask, runs reads in the same batch, and resumes when approved", async () => {
    const { calls, list } = tools();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("lookup", { q: "dana" }, { id: "call_l" }),
          fauxToolCall("send_email", { to: "dana@example.com", body: "Running late" }, { id: "call_s" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const first = await run({ history: [ask("Tell Dana I'm late")], tools: list });

    expect(first.reason).toBe("approval");
    expect(first.pending).toEqual([
      { id: "call_s", name: "send_email", input: { to: "dana@example.com", body: "Running late" }, risk: "write" },
    ]);
    expect(calls.send).toEqual([]);
    expect(calls.lookup).toEqual(["dana"]);
    // The pending call has no result row; the read's result does.
    expect(first.messages.flatMap((row) => row.tool_results ?? []).map((r) => r.tool_use_id)).toEqual(["call_l"]);
    expect(faux.state.callCount).toBe(1);

    const history = [ask("Tell Dana I'm late"), ...first.messages];

    // Woken again without an answer: still waiting, and no model call.
    const again = await run({ history, tools: list });
    expect(again.reason).toBe("approval");
    expect(again.pending.map((call) => call.id)).toEqual(["call_s"]);
    expect(faux.state.callCount).toBe(1);

    const seen: { context?: Context } = {};
    faux.setResponses([seeing("Sent.", seen)]);
    const second = await run({ history, tools: list, resume: [{ call: first.pending[0], decision: "approve" }] });

    expect(second.reason).toBe("done");
    expect(calls.send).toEqual(["dana@example.com"]);
    expect(second.messages[0].tool_results).toEqual([{ tool_use_id: "call_s", content: "sent to dana@example.com", is_error: false }]);
    expect(second.messages[1].content).toBe("Sent.");
    const results = seen.context!.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
    expect(results.map((m) => [m.toolCallId, m.isError])).toEqual([
      ["call_l", false],
      ["call_s", false],
    ]);
  });

  it("never runs an approved call twice, and ignores a resolution for a call the history lacks", async () => {
    const { calls, list } = tools();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("send_email", { to: "dana@example.com", body: "hi" }, { id: "call_s" })])]);
    const first = await run({ history: [ask("Email Dana")], tools: list });
    const approve = { call: first.pending[0], decision: "approve" as const };

    faux.setResponses([fauxAssistantMessage("Sent.")]);
    const second = await run({ history: [ask("Email Dana"), ...first.messages], tools: list, resume: [approve] });
    expect(calls.send).toEqual(["dana@example.com"]);

    // A retried wake hands the same approval in again, with the result already stored.
    faux.setResponses([fauxAssistantMessage("Already sent.")]);
    await run({ history: [ask("Email Dana"), ...first.messages, ...second.messages, ask("thanks")], tools: list, resume: [approve] });
    expect(calls.send).toEqual(["dana@example.com"]);

    // A resolution naming a call the model never made, or with altered input, runs nothing new.
    faux.setResponses([fauxAssistantMessage("ok")]);
    const forged = { call: { ...first.pending[0], id: "call_other", input: { to: "eve@example.com", body: "x" } }, decision: "approve" as const };
    await run({ history: [ask("Email Dana"), ...first.messages, ...second.messages, ask("hi")], tools: list, resume: [forged] });
    expect(calls.send).toEqual(["dana@example.com"]);
  });

  it("tells the model a declined call did not run", async () => {
    const { calls, list } = tools();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("send_email", { to: "a@b.c", body: "x" }, { id: "call_s" })])]);
    const first = await run({ history: [ask("Email them")], tools: list });
    expect(first.reason).toBe("approval");

    const seen: { context?: Context } = {};
    faux.setResponses([seeing("Okay, I won't.", seen)]);
    const second = await run({
      history: [ask("Email them"), ...first.messages],
      tools: list,
      resume: [{ call: first.pending[0], decision: "decline", note: "not now" }],
    });

    expect(second.reason).toBe("done");
    expect(calls.send).toEqual([]);
    const result = seen.context!.messages.at(-1) as ToolResultMessage;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not now");
  });

  it("answers a refused call with an error and keeps going", async () => {
    const { calls, list } = tools();
    const seen: { context?: Context } = {};
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("send_email", { to: "a@b.c", body: "x" }, { id: "call_s" })]),
      seeing("I can't send email here.", seen),
    ]);
    const result = await run({
      history: [ask("Email them")],
      tools: list,
      gate: (call) => (call.name === "send_email" ? { verdict: "refuse", reason: "Sending is off." } : "allow"),
    });

    expect(result.reason).toBe("done");
    expect(result.pending).toEqual([]);
    expect(calls.send).toEqual([]);
    expect(result.messages[1].tool_results).toEqual([{ tool_use_id: "call_s", content: "Sending is off.", is_error: true }]);
    expect((seen.context!.messages.at(-1) as ToolResultMessage).isError).toBe(true);
    expect(result.messages[2].content).toBe("I can't send email here.");
  });

  it("treats a gate that throws as ask", async () => {
    const { calls, list } = tools();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("lookup", { q: "x" }, { id: "call_1" })])]);
    const result = await run({
      history: [ask("Look")],
      tools: list,
      gate: () => {
        throw new Error("rules table unavailable");
      },
    });
    expect(result.reason).toBe("approval");
    expect(result.pending.map((call) => call.id)).toEqual(["call_1"]);
    expect(calls.lookup).toEqual([]);
  });

  it("makes no call when the ceiling cannot pay for one", async () => {
    faux.setResponses([fauxAssistantMessage("never")]);
    const result = await run({ history: [ask("Hi")], ceilingUsd: 0 });
    expect(result.reason).toBe("budget");
    expect(faux.state.callCount).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("stops with budget when the next call would pass the ceiling, and caps output to what is left", async () => {
    const big = "x".repeat(40_000); // about 10k tokens, $0.02 of input at $2 a million
    const reader = defineTool({
      name: "read_page",
      description: "Reads a page.",
      parameters: Type.Object({}),
      risk: "read",
      run: () => big,
    });
    const seen: { context?: Context; options?: StreamOptions } = {};
    faux.setResponses([
      (context, options) => {
        seen.options = options;
        return fauxAssistantMessage([fauxToolCall("read_page", {}, { id: "call_1" })]);
      },
      fauxAssistantMessage([fauxToolCall("read_page", {}, { id: "call_2" })]),
      fauxAssistantMessage("done"),
    ]);
    const result = await run({ history: [ask("Read it")], tools: [reader], ceilingUsd: 0.015 });

    expect(result.reason).toBe("budget");
    expect(faux.state.callCount).toBe(1);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeLessThan(0.015);
    // The first call's output cap was cut to what the money left buys.
    expect(seen.options!.maxTokens!).toBeLessThan(DEFAULT_MAX_TOKENS);
    expect(seen.options!.maxTokens!).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
  });

  it("stops with time at the deadline, aborting a running tool", async () => {
    const waiter = defineTool({
      name: "wait",
      description: "Waits.",
      parameters: Type.Object({}),
      risk: "read",
      run: (_args, { signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {}, { id: "call_1" })]), fauxAssistantMessage("late")]);
    const started = Date.now();
    const result = await run({ history: [ask("Wait")], tools: [waiter], deadlineMs: 50 });
    expect(result.reason).toBe("time");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(faux.state.callCount).toBe(1);
  });

  it("stops with error when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    faux.setResponses([fauxAssistantMessage("hi")]);
    const result = await run({ history: [ask("Hi")], signal: controller.signal });
    expect(result.reason).toBe("error");
    expect(result.error).toContain("cancelled");
  });

  it("reports a failed model call as error", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]);
    const result = await run({ history: [ask("Hi")] });
    expect(result.reason).toBe("error");
    expect(result.error).toBe("overloaded");
  });

  it("finishes at once when the history ends on a finished answer", async () => {
    const history: MessageRow[] = [ask("Hi"), { role: "assistant", content: "Hello", timestamp: 2 }];
    const result = await run({ history });
    expect(result.reason).toBe("done");
    expect(faux.state.callCount).toBe(0);
  });

  it("moves a late approval's result back next to its call", async () => {
    const { list } = tools();
    const seen: { context?: Context } = {};
    faux.setResponses([seeing("ok", seen)]);
    // The person typed again before the approval's result was stored.
    const history: MessageRow[] = [
      ask("Email Dana"),
      { role: "assistant", tool_calls: [{ id: "call_s", name: "send_email", input: '{"to":"d","body":"b"}' }], timestamp: 2 },
      ask("Also, hurry"),
      { role: "user", tool_results: [{ tool_use_id: "call_s", content: "sent", is_error: false }], timestamp: 4 },
    ];
    // The history ends on a result, so the loop continues from it.
    await run({ history, tools: list });
    const roles = seen.context!.messages.map((m: Message) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "user"]);
  });
});
