import { describe, expect, test } from "bun:test";
import { buildExistingMessagePatch } from "./messages";

// Per-message model arrives with the transcript sync (parser → daemon →
// addMessages). For rows synced before the field existed, the existing-uuid
// patch path is the backfill: re-syncing a transcript (resume, fork, new
// device) must stamp model onto already-stored assistant messages.

const assistantRow = {
  role: "assistant",
  content: "Reply text",
  thinking: undefined,
  tool_calls: undefined,
  tool_results: undefined,
  images: undefined,
  subtype: undefined,
  model: undefined,
};

describe("buildExistingMessagePatch model handling", () => {
  test("backfills model onto an existing assistant row that lacks it", () => {
    const patch = buildExistingMessagePatch(assistantRow, {
      ...assistantRow,
      model: "claude-opus-4-8",
    });
    expect(patch).toEqual({ model: "claude-opus-4-8" });
  });

  test("no patch when the stored model already matches", () => {
    const stored = { ...assistantRow, model: "claude-opus-4-8" };
    const patch = buildExistingMessagePatch(stored, { ...stored });
    expect(patch).toBeNull();
  });

  test("incoming without model leaves the stored value alone", () => {
    const stored = { ...assistantRow, model: "claude-opus-4-8" };
    const patch = buildExistingMessagePatch(stored, {
      ...assistantRow,
      model: undefined,
    });
    expect(patch).toBeNull();
  });

  test("user-role messages never patch model", () => {
    const patch = buildExistingMessagePatch(
      { ...assistantRow, role: "user" },
      { ...assistantRow, role: "user", model: "claude-opus-4-8" },
    );
    expect(patch).toBeNull();
  });
});
