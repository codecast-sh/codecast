import { describe, expect, test } from "bun:test";
import { findEchoedPendingMessage } from "./messages";

// The command-id coverage proof rides on echo→pending matching: the matched
// row's client_id is stamped onto the transcript row, and v2 overlays reconcile
// against that id. Matching newest-first over every status let the echo of an
// OLDER identical-content delivery stamp the NEWER command's id (ABA): the
// newer overlay retired without delivery and the delivered command's overlay
// could never reconcile. Matching is therefore delivery-ordered (oldest first)
// and restricted to rows still awaiting proof.

const row = (
  id: string,
  content: string,
  createdAt: number,
  status: string,
  clientId = id,
) => ({ _id: id, content, created_at: createdAt, status, client_id: clientId });

describe("findEchoedPendingMessage", () => {
  test("ABA regression: the echo matches the OLDER in-flight row, not the newest", () => {
    const a = row("cmd-a", "continue", 1_000, "injected");
    const b = row("cmd-b", "continue", 2_000, "pending");
    expect(findEchoedPendingMessage([b, a], "continue", 3_000)?._id).toBe("cmd-a");
  });

  test("terminal rows never re-match: a delivered twin cannot absorb the echo", () => {
    const a = row("cmd-a", "continue", 1_000, "delivered");
    const b = row("cmd-b", "continue", 2_000, "pending");
    expect(findEchoedPendingMessage([a, b], "continue", 3_000)?._id).toBe("cmd-b");
  });

  test("cancelled and undeliverable rows never match", () => {
    const a = row("cmd-a", "stop", 1_000, "cancelled");
    const b = row("cmd-b", "stop", 2_000, "undeliverable");
    expect(findEchoedPendingMessage([a, b], "stop", 3_000)).toBeUndefined();
  });

  test("a consumed row is skipped so a batch's second echo reaches the second command", () => {
    const a = row("cmd-a", "continue", 1_000, "injected");
    const b = row("cmd-b", "continue", 2_000, "injected");
    const consumed = new Set(["cmd-a"]);
    expect(findEchoedPendingMessage([a, b], "continue", 3_000, consumed)?._id).toBe("cmd-b");
  });

  test("an in-flight row outranks an older watchdog-failed twin", () => {
    const a = row("cmd-a", "continue", 1_000, "failed");
    const b = row("cmd-b", "continue", 2_000, "injected");
    expect(findEchoedPendingMessage([a, b], "continue", 3_000)?._id).toBe("cmd-b");
  });

  test("a late echo still recovers a watchdog-failed row that actually landed", () => {
    const a = row("cmd-a", "continue", 1_000, "failed");
    expect(findEchoedPendingMessage([a], "continue", 500_000)?._id).toBe("cmd-a");
  });

  test("whitespace-flattened content still matches, preserving the original fuzz", () => {
    const a = row("cmd-a", "line one\nline two", 1_000, "pending");
    expect(findEchoedPendingMessage([a], "line one line two", 2_000)?._id).toBe("cmd-a");
  });
});
