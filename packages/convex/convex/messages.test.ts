import { describe, expect, test } from "bun:test";
import {
  findDuplicateUserRow,
  getAddMessagesAgentStatusProjection,
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

describe("findDuplicateUserRow", () => {
  const t0 = 1_000_000;
  const typed = { role: "user", content: "hello", timestamp: t0 };
  const toolResultRow = { role: "user", content: "", timestamp: t0, tool_results: [{ tool_use_id: "a", content: "ok" }] };

  test("folds a re-sent typed message inside the window", () => {
    expect(findDuplicateUserRow([typed], { content: "hello", timestamp: t0 + 1000 })).toBe(typed);
  });

  test("folds an image-only echo onto the recent blank user row", () => {
    const blank = { role: "user", content: "", timestamp: t0 };
    expect(findDuplicateUserRow([blank], { content: "", timestamp: t0 + 5000, images: [{}] })).toBe(blank);
  });

  test("never folds an incoming tool result, even one carrying screenshots", () => {
    // The browser_batch shape: empty content, an image, a tool_result — arriving
    // seconds after the previous tool result row.
    expect(
      findDuplicateUserRow([toolResultRow], {
        content: "",
        timestamp: t0 + 3000,
        images: [{}],
        tool_results: [{ tool_use_id: "b", content: "[computer:screenshot] ok" }],
      }),
    ).toBeUndefined();
  });

  test("never uses an existing tool result row as the fold target", () => {
    expect(findDuplicateUserRow([toolResultRow], { content: "", timestamp: t0 + 3000, images: [{}] })).toBeUndefined();
  });

  test("applies the normalizer to the stored content", () => {
    const stored = { role: "user", content: "token=SECRET", timestamp: t0 };
    const redact = (c: string) => c.replace("SECRET", "***");
    expect(findDuplicateUserRow([stored], { content: "token=***", timestamp: t0 + 1 }, redact)).toBe(stored);
  });
});
