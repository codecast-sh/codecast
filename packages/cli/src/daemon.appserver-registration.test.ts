import { describe, expect, test } from "bun:test";
import {
  isTmuxSessionMetadataMatch,
  removeAppServerThreadRegistration,
  upsertAppServerThreadRegistration,
} from "./daemon.js";

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
