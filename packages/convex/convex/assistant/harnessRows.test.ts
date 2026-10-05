// The harness's rows must store as they are: every field a @platform/agent
// MessageRow can carry is one the batch message writer accepts, so the hosted
// turn engine never strips one (a dropped thinking signature breaks resuming
// a turn that thought before an approval).
import { describe, expect, it } from "bun:test";
import { MESSAGE_ROW_FIELDS } from "@platform/agent/history";
import { MESSAGE_BATCH_FIELDS } from "../messages";
import { rawToolInputs, signedThinkingFields, storeHostedReplay, withHostedReplay } from "../hostedReplay";
import { makeFakeDb } from "../testDb";

const conversation = "conversation" as any;
const message = "message" as any;

function setup(records: any[] = [], toolInputs: any[] = []) {
  const db = makeFakeDb({ message_thinking: records, message_tool_inputs: toolInputs });
  return { ctx: { db } as any, db };
}

// A thinking write, stored as given (no redaction).
const storeThinking = (ctx: any, msg: { thinking?: string; thinking_signature?: string; thinking_redacted?: boolean }, stored: string | undefined) =>
  storeHostedReplay(ctx, conversation, message, msg, { thinking: stored, tool_calls: undefined });

describe("harness rows", () => {
  it("are a subset of the batch writer's fields", () => {
    const missing = MESSAGE_ROW_FIELDS.filter((field) => !MESSAGE_BATCH_FIELDS.includes(field));
    expect(missing).toEqual([]);
  });

  it("keep a thinking signature only over the unredacted text", () => {
    const msg = { thinking: "plan", thinking_signature: "sig" };
    expect(signedThinkingFields(msg, "plan")).toEqual({ thinking_signature: "sig" });
    expect(signedThinkingFields(msg, "[REDACTED]")).toEqual({});
    expect(signedThinkingFields({ thinking_signature: "blob", thinking_redacted: true }, undefined)).toEqual({
      thinking_signature: "blob",
      thinking_redacted: true,
    });
    expect(signedThinkingFields({ thinking: "plan" }, "plan")).toEqual({});
  });
});

describe("thinking signatures live apart from the message row", () => {
  it("stores a signature, and clears it when new thinking arrives unsigned", async () => {
    const { ctx, db } = setup();
    await storeThinking(ctx, { thinking: "plan", thinking_signature: "sig" }, "plan");
    expect(db._tables.message_thinking).toMatchObject([{ conversation_id: conversation, message_id: message, signature: "sig" }]);

    // The row is rewritten with different thinking and no signature: the old one no longer verifies.
    await storeThinking(ctx, { thinking: "a new plan" }, "a new plan");
    expect(db._tables.message_thinking).toEqual([]);
  });

  it("drops the signature when redaction changed the thinking it covers", async () => {
    const { ctx, db } = setup([{ _id: "t1", conversation_id: conversation, message_id: message, signature: "old" }]);
    await storeThinking(ctx, { thinking: "key sk-1", thinking_signature: "new" }, "key [REDACTED]");
    expect(db._tables.message_thinking).toEqual([]);
  });

  it("leaves the record alone when a write neither carries thinking nor signs", async () => {
    const { ctx, db } = setup([{ _id: "t1", conversation_id: conversation, message_id: message, signature: "sig" }]);
    await storeThinking(ctx, {}, undefined);
    expect(db._tables.message_thinking).toHaveLength(1);
  });

  it("updates a changed signature in place, and attaches it for the turn engine", async () => {
    const { ctx, db } = setup();
    await storeThinking(ctx, { thinking: "p", thinking_signature: "s1" }, "p");
    await storeThinking(ctx, { thinking_signature: "blob", thinking_redacted: true }, undefined);
    expect(db._tables.message_thinking).toHaveLength(1);
    expect(db._tables.message_thinking[0]).toMatchObject({ signature: "blob", redacted: true });

    const rows = [
      { _id: message, conversation_id: conversation, role: "assistant", thinking: undefined },
      { _id: "other", conversation_id: conversation, role: "user", content: "hi" },
    ] as any[];
    const attached = await withHostedReplay(ctx, rows);
    expect(attached[0]).toMatchObject({ thinking_signature: "blob", thinking_redacted: true });
    expect(attached[1]).toBe(rows[1]);
  });
});

describe("raw tool inputs live apart from the message row", () => {
  const raw = [
    { id: "call_s", name: "send_email", input: '{"body":"key sk-1"}' },
    { id: "call_l", name: "lookup", input: '{"q":"dana"}' },
  ];
  const redacted = [{ ...raw[0], input: '{"body":"key [REDACTED]"}' }, raw[1]];

  it("keeps only the calls redaction changed", () => {
    expect(rawToolInputs(raw, redacted)).toEqual([{ id: "call_s", input: '{"body":"key sk-1"}' }]);
    expect(rawToolInputs(raw, raw)).toEqual([]);
  });

  it("stores them, clears them when a rewrite needs none, and puts them back for the turn engine", async () => {
    const { ctx, db } = setup();
    await storeHostedReplay(ctx, conversation, message, { tool_calls: raw }, { thinking: undefined, tool_calls: redacted });
    expect(db._tables.message_tool_inputs).toMatchObject([{ message_id: message, inputs: [{ id: "call_s", input: '{"body":"key sk-1"}' }] }]);

    const rows = [{ _id: message, conversation_id: conversation, role: "assistant", tool_calls: redacted }] as any[];
    const [replayed] = await withHostedReplay(ctx, rows);
    expect(replayed.tool_calls).toEqual(raw);
    expect(rows[0].tool_calls).toBe(redacted);

    // A write without tool calls leaves the record; one whose calls need no record clears it.
    await storeHostedReplay(ctx, conversation, message, { content: "x" } as any, { thinking: undefined, tool_calls: undefined });
    expect(db._tables.message_tool_inputs).toHaveLength(1);
    await storeHostedReplay(ctx, conversation, message, { tool_calls: [raw[1]] }, { thinking: undefined, tool_calls: [raw[1]] });
    expect(db._tables.message_tool_inputs).toEqual([]);
  });
});
