// Regression guard for jx70pyh (2026-07-29): a Workflow subagent's
// createConversation failed in a brief network outage AFTER the daemon had
// detected its parent ("Detected subagent parent for agent-a078… : jx74th3…").
// The catch block rebuilt a REDUCED param set for the retry queue — dropping
// parentConversationId/isSubagent — so the retry minted the conversation as a
// flat, unparented first-class inbox card while all its siblings nested
// correctly. The fix: the catch re-queues the exact params the direct call
// attempted. These tests drive processSessionFile with a failing sync stub and
// pin that the queued op preserves the subagent linkage.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  processSessionFile,
  subagentParentSessionFromPath,
  TEST_SCRATCH_DIRNAME,
} from "./daemon.js";
import type { SyncService, CreateConversationParams } from "./syncService.js";
import type { RetryQueue } from "./retryQueue.js";
import { isolateCodecastDir } from "./test-helpers/codecastDir.js";
import { extractSidechain } from "./parser.js";

const PARENT_SESSION = "a4c6f0c0-4251-42de-b3f3-732eb239908b";
const PARENT_CONV = "convParentJx74th3";

function makeWorkflowAgentTranscript(base: string, agentSessionId: string, cwd: string): string {
  const wfDir = path.join(base, "proj", PARENT_SESSION, "subagents", "workflows", "wf_test-123");
  fs.mkdirSync(wfDir, { recursive: true });
  const filePath = path.join(wfDir, `${agentSessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      parentUuid: null, isSidechain: true, agentId: agentSessionId.replace(/^agent-/, ""),
      type: "user", cwd, sessionId: agentSessionId,
      message: { role: "user", content: "Deep research on TEST as an investment." },
      uuid: "u1", timestamp: "2026-07-29T13:30:07.751Z",
    }),
    JSON.stringify({
      parentUuid: "u1", isSidechain: true, type: "assistant", cwd, sessionId: agentSessionId,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Working." }] },
      uuid: "u2", timestamp: "2026-07-29T13:30:08.000Z",
    }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  // Sidecar meta the daemon reads for the subagent description.
  fs.writeFileSync(filePath.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ description: "TEST research" }));
  return filePath;
}

const isolatedCodecastDir = isolateCodecastDir("daemon-sync-state-");
afterAll(() => isolatedCodecastDir.restore());

describe("subagentParentSessionFromPath", () => {
  test("plain subagent layout", () => {
    expect(subagentParentSessionFromPath(`/p/${PARENT_SESSION}/subagents/agent-abc.jsonl`)).toBe(PARENT_SESSION);
  });
  test("workflow-run layout (the jx70pyh shape)", () => {
    expect(
      subagentParentSessionFromPath(`/p/${PARENT_SESSION}/subagents/workflows/wf_7418a031-95f/agent-abc.jsonl`),
    ).toBe(PARENT_SESSION);
  });
  test("non-subagent transcript has no parent", () => {
    expect(subagentParentSessionFromPath("/p/proj/9f58ecc2-3abb.jsonl")).toBeUndefined();
    expect(subagentParentSessionFromPath("subagents/agent-abc.jsonl")).toBeUndefined();
  });
});

describe("createConversation retry preserves subagent params", () => {
  test("failed create queues the exact direct-call params, parent linkage included", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME + "-create-retry-"));
    const agentSessionId = "agent-atestretry0001";
    const projDir = path.join(base, "cwd-project");
    fs.mkdirSync(projDir, { recursive: true });
    const filePath = makeWorkflowAgentTranscript(base, agentSessionId, projDir);

    const directCalls: CreateConversationParams[] = [];
    const syncService = {
      createConversation: async (params: CreateConversationParams) => {
        directCalls.push(params);
        throw new Error("Unable to connect. Is the computer able to access the url?");
      },
    } as unknown as SyncService;

    const queued: Array<{ type: string; params: Record<string, unknown> }> = [];
    const retryQueue = {
      getPendingOperations: () => [],
      add: (type: string, params: Record<string, unknown>) => {
        queued.push({ type, params });
        return "op-id";
      },
    } as unknown as RetryQueue;

    await expect(processSessionFile(
      filePath,
      agentSessionId,
      projDir,
      syncService,
      "user123",
      undefined,
      { [PARENT_SESSION]: PARENT_CONV },
      retryQueue,
      {},
      {},
      () => {},
    )).rejects.toThrow("retains unread data");

    // The direct attempt carried the detected parent + subagent stamp…
    expect(directCalls.length).toBe(1);
    expect(directCalls[0].parentConversationId).toBe(PARENT_CONV);
    expect(directCalls[0].isSubagent).toBe(true);
    expect(directCalls[0].subagentDescription).toBe("TEST research");

    // …and the queued retry op is those SAME params, not a reduced rebuild.
    expect(queued.length).toBe(1);
    expect(queued[0].type).toBe("createConversation");
    expect(queued[0].params).toEqual(directCalls[0] as unknown as Record<string, unknown>);

    fs.rmSync(base, { recursive: true, force: true });
    // processSessionFile does real work per call (git probes on the scratch
    // project, transcript reads) and runs well past bun's 5s default here.
  }, 90_000);
});

// 2026-10-07: older Claude Code wrote sidechain (subagent/warmup) transcripts
// beside top-level sessions, not under subagents/, so the path rule minted them
// as top-level inbox cards ("Codebase exploration warmup"). The transcript's
// own records say what it is: isSidechain, with the PARENT's sessionId.
describe("a sidechain transcript outside subagents/ is still a subagent", () => {
  test("extractSidechain reads the flag and the parent session from the first message", () => {
    const side = JSON.stringify({ type: "user", isSidechain: true, sessionId: PARENT_SESSION, message: { role: "user", content: "Warmup" } });
    const plain = JSON.stringify({ type: "user", isSidechain: false, sessionId: "self", message: { role: "user", content: "Hi" } });
    const snapshot = JSON.stringify({ type: "file-history-snapshot", messageId: "m" });
    expect(extractSidechain(`${snapshot}\n${side}\n`)).toEqual({ parentSessionId: PARENT_SESSION });
    expect(extractSidechain(`${snapshot}\n${plain}\n`)).toBeUndefined();
  });

  test("create carries isSubagent and the parent named in its records", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME + "-sidechain-"));
    const agentSessionId = "agent-a54937f";
    const projDir = path.join(base, "cwd-project");
    fs.mkdirSync(projDir, { recursive: true });
    const filePath = path.join(base, "proj", `${agentSessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({ parentUuid: null, isSidechain: true, type: "user", cwd: projDir, sessionId: PARENT_SESSION, message: { role: "user", content: "Warmup" }, uuid: "w1", timestamp: "2026-10-07T05:57:49.000Z" }),
      JSON.stringify({ parentUuid: "w1", isSidechain: true, type: "assistant", cwd: projDir, sessionId: PARENT_SESSION, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Ready." }] }, uuid: "w2", timestamp: "2026-10-07T05:57:50.000Z" }),
    ].join("\n") + "\n");

    const directCalls: CreateConversationParams[] = [];
    const syncService = {
      createConversation: async (params: CreateConversationParams) => {
        directCalls.push(params);
        throw new Error("Unable to connect. Is the computer able to access the url?");
      },
    } as unknown as SyncService;
    const retryQueue = { getPendingOperations: () => [], add: () => "op-id" } as unknown as RetryQueue;

    await expect(processSessionFile(
      filePath, agentSessionId, projDir, syncService, "user123", undefined,
      { [PARENT_SESSION]: PARENT_CONV }, retryQueue, {}, {}, () => {},
    )).rejects.toThrow("retains unread data");

    expect(directCalls.length).toBe(1);
    expect(directCalls[0].isSubagent).toBe(true);
    expect(directCalls[0].parentConversationId).toBe(PARENT_CONV);

    fs.rmSync(base, { recursive: true, force: true });
  }, 90_000);
});

// The recreate path (prod answers "Conversation not found" for a cached id)
// rebuilt its params from scratch and dropped the parent, so a recreated
// subagent came back as a top-level inbox card.
describe("a recreated subagent keeps its parent", () => {
  test("conversation-not-found recreate carries isSubagent and the parent", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME + "-recreate-"));
    const agentSessionId = "agent-atestrecreate01";
    const projDir = path.join(base, "cwd-project");
    fs.mkdirSync(projDir, { recursive: true });
    const filePath = makeWorkflowAgentTranscript(base, agentSessionId, projDir);

    const creates: CreateConversationParams[] = [];
    let adds = 0;
    const syncService = new Proxy({
      createConversation: async (params: CreateConversationParams) => { creates.push(params); return "convRecreated"; },
      addMessages: async (p: any) => {
        if (adds++ === 0) throw new Error("Conversation not found");
        return { ids: p.messages.map((_: unknown, i: number) => String(i)) };
      },
    }, { get: (target: any, key) => key in target ? target[key] : async () => true }) as unknown as SyncService;
    const retryQueue = new Proxy({ getPendingOperations: () => [], add: () => "op-id" }, {
      get: (target: any, key) => key in target ? target[key] : () => false,
    }) as unknown as RetryQueue;

    await processSessionFile(
      filePath, agentSessionId, projDir, syncService, "user123", undefined,
      { [PARENT_SESSION]: PARENT_CONV, [agentSessionId]: "convGone" }, retryQueue, {}, {}, () => {},
    ).catch(() => {});

    expect(creates.length).toBe(1);
    expect(creates[0].isSubagent).toBe(true);
    expect(creates[0].parentConversationId).toBe(PARENT_CONV);

    fs.rmSync(base, { recursive: true, force: true });
  }, 90_000);
});
