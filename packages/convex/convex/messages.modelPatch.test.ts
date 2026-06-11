import { describe, expect, test } from "bun:test";
import { buildExistingMessagePatch, lastKnownModelFromBatch } from "./messages";

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

// addMessages rolls the batch's newest assistant model up to conversations.model
// (the last-known value surfaced by the inbox badge).
describe("lastKnownModelFromBatch", () => {
  test("picks the newest assistant model by timestamp", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "assistant", model: "claude-sonnet-4-6", timestamp: 100 },
        { role: "user", timestamp: 200 },
        { role: "assistant", model: "claude-opus-4-8", timestamp: 300 },
      ]),
    ).toBe("claude-opus-4-8");
  });

  test("later entry wins on equal/missing timestamps (JSONL order)", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "assistant", model: "claude-sonnet-4-6" },
        { role: "assistant", model: "claude-opus-4-8" },
      ]),
    ).toBe("claude-opus-4-8");
  });

  test("ignores synthetic banners and non-assistant roles", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "assistant", model: "claude-opus-4-8", timestamp: 100 },
        { role: "assistant", model: "<synthetic>", timestamp: 200 },
        { role: "user", model: "claude-sonnet-4-6", timestamp: 300 },
      ]),
    ).toBe("claude-opus-4-8");
  });

  test("returns null when no assistant model present", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "user", timestamp: 100 },
        { role: "assistant", model: "<synthetic>", timestamp: 200 },
      ]),
    ).toBeNull();
  });
});
