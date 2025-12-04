import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { RetryQueue, type RetryOperation } from "./retryQueue.js";

describe("Daemon retry integration", () => {
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
  });

  it("should retry createConversation and then send pending messages", async () => {
    const queue = new RetryQueue({
      initialDelayMs: 50,
      maxDelayMs: 400,
      maxAttempts: 3,
      checkIntervalMs: 25,
      onLog: (msg) => logs.push(msg),
    });

    const pendingMessages: Record<string, Array<{
      role: "human" | "assistant";
      content: string;
      timestamp: number;
    }>> = {};

    const conversationCache: Record<string, string> = {};
    const createdConversations: string[] = [];
    const addedMessages: Array<{ conversationId: string; content: string }> = [];
    let createCallCount = 0;

    queue.setExecutor(async (op: RetryOperation): Promise<boolean> => {
      if (op.type === "createConversation") {
        const params = op.params as { sessionId: string };
        createCallCount++;

        if (createCallCount < 2) {
          throw new Error("Network error - simulate failure");
        }

        const conversationId = `conv-${params.sessionId}`;
        conversationCache[params.sessionId] = conversationId;
        createdConversations.push(conversationId);

        if (pendingMessages[params.sessionId]) {
          for (const msg of pendingMessages[params.sessionId]) {
            addedMessages.push({
              conversationId,
              content: msg.content,
            });
          }
          delete pendingMessages[params.sessionId];
        }
        return true;
      }

      if (op.type === "addMessage") {
        const params = op.params as { conversationId: string; content: string };
        addedMessages.push({
          conversationId: params.conversationId,
          content: params.content,
        });
        return true;
      }

      return false;
    });

    const sessionId = "test-session-123";
    pendingMessages[sessionId] = [
      { role: "human", content: "Hello", timestamp: Date.now() },
      { role: "assistant", content: "Hi there!", timestamp: Date.now() },
    ];

    queue.add("createConversation", {
      userId: "user-1",
      sessionId,
      agentType: "claude_code",
      projectPath: "/test/project",
    }, "Initial failure");

    await new Promise((r) => setTimeout(r, 100));
    expect(createCallCount).toBe(1);
    expect(queue.getQueueSize()).toBe(1);

    await new Promise((r) => setTimeout(r, 100));
    expect(createCallCount).toBe(2);
    expect(queue.getQueueSize()).toBe(0);

    expect(createdConversations).toContain(`conv-${sessionId}`);
    expect(addedMessages.length).toBe(2);
    expect(addedMessages[0].content).toBe("Hello");
    expect(addedMessages[1].content).toBe("Hi there!");

    expect(logs.some((l) => l.includes("Queued createConversation"))).toBe(true);
    expect(logs.some((l) => l.includes("Retrying createConversation"))).toBe(true);
    expect(logs.some((l) => l.includes("Retry succeeded"))).toBe(true);

    queue.stop();
  });

  it("should handle addMessage failures independently", async () => {
    const queue = new RetryQueue({
      initialDelayMs: 50,
      maxDelayMs: 400,
      maxAttempts: 3,
      checkIntervalMs: 25,
      onLog: (msg) => logs.push(msg),
    });

    const addedMessages: string[] = [];
    let callCount = 0;

    queue.setExecutor(async (op: RetryOperation): Promise<boolean> => {
      if (op.type === "addMessage") {
        callCount++;
        const params = op.params as { content: string };

        if (callCount < 3) {
          throw new Error("Network timeout");
        }

        addedMessages.push(params.content);
        return true;
      }
      return false;
    });

    queue.add("addMessage", {
      conversationId: "conv-1",
      role: "human",
      content: "Test message",
      timestamp: Date.now(),
    }, "Initial network error");

    await new Promise((r) => setTimeout(r, 500));

    expect(callCount).toBe(3);
    expect(addedMessages).toContain("Test message");
    expect(logs.some((l) => l.includes("Network timeout"))).toBe(true);

    queue.stop();
  });

  it("should log delays in exponential backoff pattern", async () => {
    const retryLogs: string[] = [];
    const queue = new RetryQueue({
      initialDelayMs: 50,
      maxDelayMs: 400,
      maxAttempts: 3,
      checkIntervalMs: 25,
      onLog: (msg) => retryLogs.push(msg),
    });

    queue.setExecutor(async () => {
      throw new Error("Always fail");
    });

    queue.add("addMessage", { content: "test" });

    await new Promise((r) => setTimeout(r, 600));

    const delayLogs = retryLogs.filter((l) => l.includes("Next retry in"));
    expect(delayLogs.length).toBe(2);

    const firstDelay = parseInt(delayLogs[0].match(/(\d+)ms/)?.[1] || "0");
    const secondDelay = parseInt(delayLogs[1].match(/(\d+)ms/)?.[1] || "0");

    expect(secondDelay).toBeGreaterThan(firstDelay);

    queue.stop();
  });
});
