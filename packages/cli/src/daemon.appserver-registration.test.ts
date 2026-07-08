import { describe, expect, test } from "bun:test";
import {
  buildAppServerStreamingTailMessages,
  buildCodexUserTurnMessage,
  isTmuxSessionMetadataMatch,
  removeAppServerThreadRegistration,
  upsertAppServerThreadRegistration,
} from "./daemon.js";

// Regression: ct-36429. Codex's app-server only streams the agent's output back, so the
// daemon records the user turn itself at delivery time. The message must be role "user"
// (so the server's addMessages content-matches the pending row and reconciles the web's
// optimistic bubble) with a stable, per-pending-message uuid so re-delivery is idempotent.
describe("buildCodexUserTurnMessage", () => {
  test("builds an idempotent user-role message keyed to the pending id", () => {
    const msg = buildCodexUserTurnMessage("investigate the video sync bug", "pm-123", 1000);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("investigate the video sync bug");
    expect(msg.uuid).toBe("codex-user-pm-123");
    expect(msg.timestamp).toBe(1000);
  });

  test("derives the same uuid for the same pending message (re-delivery dedupe)", () => {
    const a = buildCodexUserTurnMessage("hi", "pm-9", 1);
    const b = buildCodexUserTurnMessage("hi", "pm-9", 2);
    expect(a.uuid).toBe(b.uuid);
  });
});

describe("buildAppServerStreamingTailMessages", () => {
  test("uses the final converter identity for an adjacent streaming assistant item", () => {
    const messages = buildAppServerStreamingTailMessages(
      [{ type: "agentMessage", id: "msg-1", text: "Already synced.", phase: "commentary" } as any],
      [{ itemId: "msg-2", content: "Still streaming." }],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.uuid).toBe("msg-1");
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.content).toBe("Already synced.\nStill streaming.");
    expect(messages[0]?.subtype).toBeUndefined();
  });

  test("skips whitespace-only streaming tails", () => {
    expect(buildAppServerStreamingTailMessages([], [{ itemId: "msg-1", content: "   " }])).toEqual([]);
  });
});

describe("app-server thread registration", () => {
  test("keeps conversation and thread mappings one-to-one", () => {
    const threads = new Map<string, { threadId: string; conversationId: string }>();
    const conversations = new Map<string, string>();

    upsertAppServerThreadRegistration(threads, conversations, "conv-a", "thread-1");
    upsertAppServerThreadRegistration(threads, conversations, "conv-b", "thread-1");

    expect(conversations.get("conv-a")).toBeUndefined();
    expect(conversations.get("conv-b")).toBe("thread-1");
    expect(threads.get("thread-1")).toEqual({ threadId: "thread-1", conversationId: "conv-b" });
  });

  test("drops both sides of the mapping on removal", () => {
    const threads = new Map<string, { threadId: string; conversationId: string }>();
    const conversations = new Map<string, string>();

    upsertAppServerThreadRegistration(threads, conversations, "conv-a", "thread-1");
    removeAppServerThreadRegistration(threads, conversations, "conv-a");

    expect(conversations.size).toBe(0);
    expect(threads.size).toBe(0);
  });

  test("requires an exact full session id match for tmux metadata", () => {
    const sessionA = "019d1bd3-d1dc-7d32-8fd0-39d33ee384b3";
    const sessionB = "019d1bd3-3932-7d40-825e-eacedf960d05";

    expect(isTmuxSessionMetadataMatch(sessionA, sessionA)).toBe(true);
    expect(isTmuxSessionMetadataMatch(sessionA.slice(0, 8), sessionA)).toBe(false);
    expect(isTmuxSessionMetadataMatch(sessionB, sessionA)).toBe(false);
  });
});
