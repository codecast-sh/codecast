import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { processCodexSession } from "./daemon.js";
import { formatAgentPrompt } from "./agentPromptOrigin.js";
import type { CreateConversationParams, SyncService } from "./syncService.js";
import type { RetryQueue } from "./retryQueue.js";
import { isolateCodecastDir } from "./test-helpers/codecastDir.js";

const isolated = isolateCodecastDir("codex-subagent-prompt-");
afterAll(() => isolated.restore());
const parent = "jx70pj3pgb4jjmcka1sbxnna3h8erqge";

async function firstCreate(source: string): Promise<{ creates: CreateConversationParams[]; queued: Array<{ type: string; params: Record<string, unknown> }>; cwd: string }> {
  // The session's cwd is inside, so no test-scratch name: the sync scope refuses that folder.
  const dir = mkdtempSync(join(tmpdir(), "codex-subagent-"));
  try {
    const sessionId = randomUUID();
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    const file = join(dir, `rollout-${sessionId}.jsonl`);
    const timestamp = "2026-09-20T20:36:13.000Z";
    writeFileSync(file, [
      { type: "session_meta", timestamp, payload: { id: sessionId, cwd, source } },
      { type: "response_item", timestamp, payload: { type: "message", id: "launch", role: "user", content: [{ type: "input_text", text: formatAgentPrompt(parent, "Read the History UI brief and execute it.", true) }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const creates: CreateConversationParams[] = [];
    const queued: Array<{ type: string; params: Record<string, unknown> }> = [];
    const sync = {
      createConversation: async (params: CreateConversationParams) => {
        creates.push(params);
        throw new Error("Unable to connect");
      },
    } as unknown as SyncService;
    const retry = {
      getPendingOperations: () => [],
      add: (type: string, params: Record<string, unknown>) => {
        queued.push({ type, params });
        return "retry";
      },
    } as unknown as RetryQueue;
    await expect(processCodexSession(file, sessionId, sync, "user", undefined, { "parent-native": parent }, retry, {}, {}, () => {})).rejects.toThrow("retains unread data");
    return { creates, queued, cwd };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a Codex launch marker supplies the parent before creation and survives a failed create", async () => {
  const { creates, queued, cwd } = await firstCreate("cli");
  expect(creates).toHaveLength(1);
  // An interactive codex the lead launched runs its own process.
  expect(creates[0]).toMatchObject({ parentConversationId: parent, isSubagent: true, runsInParent: false, projectPath: cwd, agentType: "codex" });
  expect(queued).toEqual([{ type: "createConversation", params: { ...creates[0] } }]);
}, 90_000);

test("a `codex exec` child of a lead runs inside it", async () => {
  const { creates } = await firstCreate("exec");
  expect(creates[0]).toMatchObject({ parentConversationId: parent, runsInParent: true, cliFlags: "--print" });
}, 90_000);
