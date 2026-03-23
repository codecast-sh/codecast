import { describe, expect, test } from "bun:test";
import {
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
});
