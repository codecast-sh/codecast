// Regression guard for jx7akcgc (2026-09-02): an agent-team teammate's
// createConversation hit a Convex write conflict and fell to the retry queue.
// The retry minted the row four seconds later, but the lead link
// (maybeLinkTeamSpawn) lived inside the create try block on the direct path,
// so the throw skipped it and no later pass ever retried — the teammate synced
// with agent_team_name/agent_name and NO spawned_by_conversation_id, and
// rendered as a loose first-class card while its siblings nested under the
// lead. The fix runs the link gate on every pass once a conversation exists.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processSessionFile, TEST_SCRATCH_DIRNAME } from "./daemon.js";
import type { SyncService } from "./syncService.js";
import type { RetryQueue } from "./retryQueue.js";

const TEAM = "session-7406f3cf";
const AGENT = "fm-sending-3";
const LEAD_SESSION = "7406f3cf-0cba-4555-89f4-9de07bb99d35";
const LEAD_CONV = "convLeadJx788p3";
const TEAMMATE_SESSION = "7e57a0e0-0000-4000-8000-0000000e5e1d";
const TEAMMATE_CONV = "convTeammateJx7akcgc";

function teammateLine(uuid: string, parentUuid: string | null, role: "user" | "assistant", cwd: string, ts: string): string {
  return JSON.stringify({
    parentUuid, isSidechain: false, type: role, cwd, sessionId: TEAMMATE_SESSION,
    teamName: TEAM, agentName: AGENT, version: "2.1.259",
    message: role === "user"
      ? { role, content: "Read /tmp/featmap/BRIEF.md first." }
      : { role, stop_reason: "end_turn", content: [{ type: "text", text: "Working." }] },
    uuid, timestamp: ts,
  });
}

let base: string;
let projDir: string;
let filePath: string;
let savedHome: string | undefined;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME + "-teammate-link-"));
  projDir = path.join(base, "cwd-project");
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(base, "proj"), { recursive: true });
  filePath = path.join(base, "proj", `${TEAMMATE_SESSION}.jsonl`);
  fs.writeFileSync(filePath, [
    teammateLine("u1", null, "user", projDir, "2026-09-02T22:21:56.049Z"),
    teammateLine("a1", "u1", "assistant", projDir, "2026-09-02T22:21:58.000Z"),
  ].join("\n") + "\n");
  // The resolver's fast path: ~/.claude/teams/<team>/config.json names a lead
  // session id that the conversation cache resolves.
  const teamDir = path.join(base, ".claude", "teams", TEAM);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({
    name: TEAM, leadSessionId: LEAD_SESSION,
    members: [
      { agentId: `team-lead@${TEAM}`, name: "team-lead", backendType: "in-process", tmuxPaneId: "leader" },
      { agentId: `${AGENT}@${TEAM}`, name: AGENT, backendType: "tmux", tmuxPaneId: "%328" },
    ],
  }));
  savedHome = process.env.HOME;
  process.env.HOME = base;
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("teammate lead link survives a create that fell to the retry queue", () => {
  test("no link on the failed-create pass, link on the next pass once the retry minted the row", async () => {
    const links: unknown[][] = [];
    let createCalls = 0;
    const syncService = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (prop === "createConversation") return async () => {
          createCalls++;
          throw new Error('{"code":"OptimisticConcurrencyControlFailure","message":"Documents read from or written to the \\"sync_heads\\" table changed"}');
        };
        if (prop === "linkSpawnedBy") return async (...args: unknown[]) => { links.push(args); };
        return async () => undefined;
      },
    }) as unknown as SyncService;
    const retryQueue = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (prop === "add") return () => "op-id";
        if (prop === "hasPendingConversation") return () => false;
        return () => undefined;
      },
    }) as unknown as RetryQueue;
    const conversationCache: Record<string, string> = { [LEAD_SESSION]: LEAD_CONV };
    const pendingMessages: Record<string, unknown[]> = {};

    // Pass 1: the direct create throws → queued for retry. No conversation
    // exists yet, so no link may be attempted (an attempt here would burn one
    // of the bounded tries against a row that does not exist).
    await processSessionFile(filePath, TEAMMATE_SESSION, projDir, syncService, "user123", undefined,
      conversationCache, retryQueue, pendingMessages as any, {}, () => {});
    expect(createCalls).toBe(1);
    expect(links).toEqual([]);

    // The retry executor mints the row and caches it (daemon retry path).
    conversationCache[TEAMMATE_SESSION] = TEAMMATE_CONV;
    // The teammate keeps writing; every line carries the team stamp.
    fs.appendFileSync(filePath, teammateLine("u2", "a1", "user", projDir, "2026-09-02T22:22:20.000Z") + "\n");

    // Pass 2: a cached conversation + the stamp → link to the resolved lead.
    await processSessionFile(filePath, TEAMMATE_SESSION, projDir, syncService, "user123", undefined,
      conversationCache, retryQueue, pendingMessages as any, {}, () => {});
    await new Promise((r) => setTimeout(r, 50)); // the link is fire-and-forget
    expect(createCalls).toBe(1);
    expect(links).toEqual([[LEAD_CONV, TEAMMATE_CONV, TEAM, AGENT]]);
  }, 90_000);
});
