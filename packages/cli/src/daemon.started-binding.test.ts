import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { matchStartedConversation } from "./sessionProcessMatcher";
import { functionBlock } from "./test-helpers/sourceRegion";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

function fixture() {
  const startedSessionTmux = new Map([
    ["call", { agentType: "claude", sessionId: "assigned", tmuxSession: "call-pane", projectPath: "/repo", startedAt: 0 }],
    ["other", { agentType: "claude", sessionId: "other-session", tmuxSession: "other-pane", projectPath: "/repo", startedAt: 0 }],
  ]);
  const bindings: unknown[][] = [];
  const cache: Record<string, string> = {};
  let probes = 0;
  const deps = {
    startedSessionTmux,
    matchStartedConversation,
    findSessionProcess: async () => { probes++; throw new Error("ETIMEDOUT"); },
    sessionProcessCache: new Map(),
    findTmuxPaneForTty: async () => { probes++; throw new Error("ETIMEDOUT"); },
    cacheSessionProcess: () => {},
    log: () => {},
    saveConversationCache: (value: Record<string, string>) => Object.assign(cache, value),
    getGitInfo: async () => undefined,
    pushSessionIdBinding: async (...args: unknown[]) => { bindings.push(args); },
    registerManagedStartedSession: () => {},
    stopManagedSessionHeartbeat: () => {},
    deleteStartedSession: (id: string) => startedSessionTmux.delete(id),
  };
  const code = ["matchStartedStub", "adoptStartedStub"].map(name => functionBlock(source, name).text).join("\n");
  const api = new Function(...Object.keys(deps), new Bun.Transpiler({ loader: "ts" }).transformSync(code) + "\nreturn { matchStartedStub, adoptStartedStub };")(...Object.values(deps));
  return { ...api, startedSessionTmux, cache, bindings, probes: () => probes };
}

describe("started transcript binding", () => {
  test("a delayed transcript binds to its original call without any terminal probe", async () => {
    const f = fixture();
    const match = await f.matchStartedStub("claude", "assigned", "/repo");
    expect(match).toEqual({ conversationId: "call" });
    const id = await f.adoptStartedStub("claude", match.conversationId, "assigned", "/repo", f.cache);
    expect(id).toBe("call");
    expect(f.cache.assigned).toBe("call");
    expect(f.bindings).toEqual([["call", "assigned", "/repo", undefined, undefined]]);
    expect(f.startedSessionTmux.has("call")).toBe(false);
    expect(f.startedSessionTmux.has("other")).toBe(true);
    expect(f.probes()).toBe(0);
  });

  test("a transcript from another client cannot take the assigned call", async () => {
    const f = fixture();
    expect(await f.matchStartedStub("codex", "assigned", "/repo")).toBeNull();
    expect(f.bindings).toEqual([]);
  });
});
