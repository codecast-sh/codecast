// The harness's rows must store as they are: every field a @platform/agent
// MessageRow can carry is one the batch message writer accepts, so the hosted
// turn engine never strips one (a dropped thinking signature breaks resuming
// a turn that thought before an approval).
import { describe, expect, it } from "bun:test";
import { MESSAGE_ROW_FIELDS } from "@platform/agent/history";
import { MESSAGE_BATCH_FIELDS, signedThinkingFields } from "../messages";

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
