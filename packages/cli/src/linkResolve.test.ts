import { describe, test, expect } from "bun:test";
import { resolveCurrentConversationId } from "./linkResolve";

// Regression for the `cast link` failure in a session's first minute: the
// server-side session_id binding rides the daemon's retry queue, so a fresh
// spawn/resume misses on the server while ~/.codecast/conversations.json
// already has the mapping. Local must win, and misses must retry.

const noSleep = () => Promise.resolve();

describe("resolveCurrentConversationId", () => {
  test("local map answers without touching the server", async () => {
    let serverCalls = 0;
    const result = await resolveCurrentConversationId("sess-1", {
      readLocalMap: () => ({ "sess-1": "conv-full-id" }),
      resolveOnServer: async () => { serverCalls++; return null; },
      sleep: noSleep,
    });
    expect(result).toBe("conv-full-id");
    expect(serverCalls).toBe(0);
  });

  test("falls back to the server when local misses", async () => {
    const result = await resolveCurrentConversationId("sess-1", {
      readLocalMap: () => ({}),
      resolveOnServer: async () => "conv-from-server",
      sleep: noSleep,
    });
    expect(result).toBe("conv-from-server");
  });

  test("retries until the daemon writes the local map", async () => {
    let reads = 0;
    let serverCalls = 0;
    const result = await resolveCurrentConversationId("sess-1", {
      // The daemon discovers the JSONL between attempts 1 and 2.
      readLocalMap: (): Record<string, string> => (++reads >= 2 ? { "sess-1": "conv-late" } : {}),
      resolveOnServer: async () => { serverCalls++; return null; },
      sleep: noSleep,
    });
    expect(result).toBe("conv-late");
    expect(serverCalls).toBe(1);
  });

  test("returns null after exhausting attempts", async () => {
    let serverCalls = 0;
    const result = await resolveCurrentConversationId("sess-1", {
      readLocalMap: () => ({}),
      resolveOnServer: async () => { serverCalls++; return null; },
      sleep: noSleep,
      attempts: 3,
    });
    expect(result).toBeNull();
    expect(serverCalls).toBe(3);
  });
});
