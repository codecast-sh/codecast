import { describe, expect, test } from "bun:test";
import {
  getAddMessagesAgentStatusProjection,
  shouldApplyMessageSourceRevision,
  shouldApplyAddMessagesAgentStatusProjection,
} from "./messages";

describe("getAddMessagesAgentStatusProjection", () => {
  test("projects assistant batches for off-hot-path agent status updates", () => {
    expect(
      getAddMessagesAgentStatusProjection([
        { role: "assistant" },
      ]),
    ).toEqual({
      has_assistant_message: true,
      has_tool_result_reply: false,
    });
  });

  test("projects user tool-result replies that can clear permission_blocked", () => {
    expect(
      getAddMessagesAgentStatusProjection([
        { role: "user", tool_results: [{ tool_use_id: "t1", content: "yes" }] },
      ]),
    ).toEqual({
      has_assistant_message: false,
      has_tool_result_reply: true,
    });
  });

  test("skips ordinary user batches so addMessages does not schedule extra work", () => {
    expect(
      getAddMessagesAgentStatusProjection([
        { role: "user" },
      ]),
    ).toBeNull();
  });
});

describe("shouldApplyAddMessagesAgentStatusProjection", () => {
  test("applies when the session status has not changed since scheduling", () => {
    expect(shouldApplyAddMessagesAgentStatusProjection(100, 100)).toBe(true);
    expect(shouldApplyAddMessagesAgentStatusProjection(90, 100)).toBe(true);
    expect(shouldApplyAddMessagesAgentStatusProjection(undefined, 100)).toBe(true);
  });

  test("skips when a newer daemon status update landed after scheduling", () => {
    expect(shouldApplyAddMessagesAgentStatusProjection(101, 100)).toBe(false);
  });
});

describe("shouldApplyMessageSourceRevision", () => {
  test("accepts a newer revision and rejects equal or stale retries", () => {
    const stored = { source_device_id: "device-a", source_revision: 11 };
    expect(shouldApplyMessageSourceRevision(
      stored,
      { source_device_id: "device-a", source_revision: 12 },
      "device-a",
    )).toBe(true);
    expect(shouldApplyMessageSourceRevision(
      stored,
      { source_device_id: "device-a", source_revision: 11 },
      "device-a",
    )).toBe(false);
    expect(shouldApplyMessageSourceRevision(
      stored,
      { source_device_id: "device-a", source_revision: 10 },
      "device-a",
    )).toBe(false);
  });

  test("fences a stale daemon after conversation ownership moves devices", () => {
    expect(shouldApplyMessageSourceRevision(
      { source_device_id: "old-device", source_revision: 500 },
      { source_device_id: "old-device", source_revision: 501 },
      "new-device",
    )).toBe(false);
    expect(shouldApplyMessageSourceRevision(
      { source_device_id: "old-device", source_revision: 500 },
      { source_device_id: "new-device", source_revision: 1 },
      "new-device",
    )).toBe(true);
  });

  test("legacy writers remain compatible but cannot overwrite revisioned rows", () => {
    expect(shouldApplyMessageSourceRevision(
      {},
      {},
      "device-a",
    )).toBe(true);
    expect(shouldApplyMessageSourceRevision(
      {},
      { source_device_id: "device-a", source_revision: 1 },
      "device-a",
    )).toBe(true);
    expect(shouldApplyMessageSourceRevision(
      { source_device_id: "device-a", source_revision: 1 },
      {},
      "device-a",
    )).toBe(false);
  });
});
