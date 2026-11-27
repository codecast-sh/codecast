// A finished Task subagent is marked completed, and reopened when its
// transcript grows again (subagentFinish.ts). These drive processSessionFile
// for a real subagent transcript and pin that the daemon's tracker hears every
// synced pass.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processSessionFile, subagentFinish, TEST_SCRATCH_DIRNAME } from "./daemon.js";
import type { SyncService } from "./syncService.js";
import type { RetryQueue } from "./retryQueue.js";
import { isolateCodecastDir } from "./test-helpers/codecastDir.js";
import { pollUntil } from "./test-helpers/pollUntil.js";

const PARENT_SESSION = "b5d7a1d1-5362-43ef-c4a7-843fc340019c";

const isolatedCodecastDir = isolateCodecastDir("daemon-subagent-finish-");
afterAll(() => isolatedCodecastDir.restore());

function line(sessionId: string, cwd: string, uuid: string, role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    parentUuid: null, isSidechain: true, type: role, cwd, sessionId, uuid, timestamp: new Date().toISOString(),
    message: role === "user" ? { role, content: text } : { role, stop_reason: "end_turn", content: [{ type: "text", text }] },
  });
}

describe("processSessionFile feeds the subagent finish tracker", () => {
  test("finished meta completes the row; a resumed run's lines reopen it", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME + "-subagent-finish-"));
    const agentSessionId = "agent-afinish0001";
    const projDir = path.join(base, "cwd-project");
    fs.mkdirSync(projDir, { recursive: true });
    const dir = path.join(base, "proj", PARENT_SESSION, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${agentSessionId}.jsonl`);
    const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
    fs.writeFileSync(filePath, [line(agentSessionId, projDir, "f1", "user", "Do it."), line(agentSessionId, projDir, "f2", "assistant", "Done.")].join("\n") + "\n");
    fs.writeFileSync(metaPath, JSON.stringify({ agentType: "general-purpose", description: "Do it", finished: true }));

    const status: string[] = [];
    const syncService = new Proxy({
      addMessages: async (p: any) => ({ ids: p.messages.map((_: unknown, i: number) => String(i)) }),
      markSessionCompleted: async (id: string) => { status.push(`completed:${id}`); },
      markSessionActive: async (id: string) => { status.push(`active:${id}`); },
    }, { get: (target: any, key) => key in target ? target[key] : async () => true }) as unknown as SyncService;
    const retryQueue = new Proxy({ getPendingOperations: () => [], add: () => "op-id" }, {
      get: (target: any, key) => key in target ? target[key] : () => false,
    }) as unknown as RetryQueue;
    const cache = { [agentSessionId]: "convChild" };
    const run = () => processSessionFile(filePath, agentSessionId, projDir, syncService, "user123", undefined, cache, retryQueue, {}, {}, () => {});

    try {
      // First pass this daemon sees: an earlier run may have completed it.
      await run();
      await pollUntil(() => status.length === 1, "first-pass active assertion");
      await subagentFinish.check(filePath);
      expect(status).toEqual(["active:convChild", "completed:convChild"]);

      // The parent resumes it: Claude Code rewrites the meta without
      // `finished` (2.1.332) and new lines land.
      const later = new Date(Date.now() + 120_000);
      fs.writeFileSync(metaPath, JSON.stringify({ agentType: "general-purpose", description: "Do it" }));
      fs.appendFileSync(filePath, line(agentSessionId, projDir, "f3", "user", "One more thing.") + "\n");
      fs.utimesSync(filePath, later, later);
      await run();
      await pollUntil(() => status.length === 3, "reopen on growth");
      await subagentFinish.check(filePath);
      expect(status).toEqual(["active:convChild", "completed:convChild", "active:convChild"]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 90_000);
});
