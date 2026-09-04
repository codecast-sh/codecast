import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import {
  agentSwitchConversationId,
  buildAppServerStreamingTailMessages,
  buildCodexUserTurnMessage,
  codexForkParentIdFromHead,
  isAppServerOwnedCodexTranscript,
  isTmuxSessionMetadataMatch,
  removeAppServerThreadRegistration,
  upsertAppServerThreadRegistration,
} from "./daemon.js";

describe("Codex app-server transcript ownership", () => {
  const forkHead = (sessionId: string, parentId: string) => JSON.stringify({
    type: "session_meta",
    payload: { id: sessionId, originator: "codex_cli_rs", source: "vscode", forked_from_id: parentId },
  });

  test("recognizes an app-server fork before its returned thread id is registered", () => {
    const head = forkHead("thread-new", "import-source");
    expect(codexForkParentIdFromHead(head)).toBe("import-source");
    expect(isAppServerOwnedCodexTranscript(
      "thread-new",
      head,
      new Set(),
      new Set(),
      new Set(["import-source"]),
    )).toBe(true);
  });

  test("keeps registered and persisted app-server threads out of file sync", () => {
    const normalHead = '{"type":"session_meta","payload":{"originator":"codex_cli_rs","source":"vscode"}}';
    expect(isAppServerOwnedCodexTranscript("thread-live", normalHead, new Set(["thread-live"]), new Set(), new Set())).toBe(true);
    expect(isAppServerOwnedCodexTranscript("thread-persisted", normalHead, new Set(), new Set(["thread-persisted"]), new Set())).toBe(true);
    expect(isAppServerOwnedCodexTranscript("thread-cli", normalHead, new Set(), new Set(), new Set())).toBe(false);
  });
});

describe("agent switch command gating", () => {
  test("holds delivery for an in-place agent switch", () => {
    expect(agentSwitchConversationId({
      command: "resume_session",
      args: JSON.stringify({ conversation_id: "conv-a", switch_agent: true }),
    })).toBe("conv-a");
  });

  test("ignores ordinary resumes and malformed command payloads", () => {
    expect(agentSwitchConversationId({
      command: "resume_session",
      args: JSON.stringify({ conversation_id: "conv-a" }),
    })).toBeUndefined();
    expect(agentSwitchConversationId({ command: "kill_session", args: "{" })).toBeUndefined();
  });
});

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

describe("Codex history import routing", () => {
  test("imports copied history through app-server before generic resume", () => {
    const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
    const start = source.indexOf('if (resumeAgentType === "codex" && (parsed.fork === true || forceReconstitute) && conversationId)');
    const end = source.indexOf("let resumed = false", start);
    const branch = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain("activeCodexAppServer.threadFork");
    expect(branch).toContain("remapConversationSession(sessionId, realThreadId, conversationId)");
    expect(branch).toContain('transport: "app-server"');
    expect(branch).not.toContain("autoResumeSession");
    expect(branch).not.toContain("tmux");
  });

  test("routes an agent switch to Codex through app-server, not tmux resume", () => {
    const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
    expect(source).toContain('parsed.switch_agent === true && conversationId && resumeAgentType !== "codex"');

    const start = source.indexOf('if (resumeAgentType === "codex" && (parsed.fork === true || forceReconstitute) && conversationId)');
    const end = source.indexOf("let resumed = false", start);
    const branch = source.slice(start, end);

    expect(branch).toContain("activeCodexAppServer.threadFork");
    expect(branch).toContain("threadForkTimeoutMsForBytes(importBytes)");
    expect(branch).toContain("}, forkTimeoutMs)");
    expect(branch).toContain('switchingAgent ? { switched: true } : { forked: true }');
    expect(branch).toContain('transport: "app-server"');
    expect(branch).toContain("unregisterManagedSession(sessionId)");
    expect(branch).toContain("setSessionError(conversationId, error)");
    expect(branch.indexOf("unregisterManagedSession(sessionId)")).toBeLessThan(branch.indexOf("setSessionError(conversationId, error)"));
    expect(branch).not.toContain("autoResumeSession");
    expect(branch.indexOf("pendingAppServerForkParents.add")).toBeLessThan(branch.indexOf("registerAppServerConversation"));
    expect(branch.indexOf("registerAppServerConversation")).toBeLessThan(branch.indexOf("pendingAppServerForkParents.delete"));
  });

  test("defers pending messages until the replacement backend is registered", () => {
    const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function deliverMessage(");
    const end = source.indexOf("const childConvId", start);
    expect(source.slice(start, end)).toContain("pendingAgentSwitches.has(conversationId)");
  });
});
