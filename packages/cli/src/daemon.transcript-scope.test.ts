// A session outside the sync scope is never uploaded, whichever agent wrote it.
// Claude and Cursor are placed by their watchers before a pass runs. Codex,
// OpenCode, pi, grok and muse name their folder inside the transcript, and
// Gemini by where it keeps the transcript, so their passes are driven here
// directly: the same entry the directory watchers, the watchdog and a retry
// all use.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  processCodexSession,
  processGeminiSession,
  processOpencodeSession,
  processTranscriptDeltaSession,
  repairProjectPaths,
  setActiveConfigForTests,
} from "./daemon.js";
import { opencodeDbPath } from "./opencodeStorage.js";
import { setPosition } from "./positionTracker.js";
import type { Config } from "./config/types.js";
import type { RetryQueue } from "./retryQueue.js";
import type { SyncService } from "./syncService.js";
import { isolateCodecastDir } from "./test-helpers/codecastDir.js";
import { strictStub } from "./test-helpers/strictStub.js";

const SELECTED = "/work/app";
const OUTSIDE = "/side/notes";
const ONLY_SELECTED: Config = { sync_mode: "selected", sync_projects: [SELECTED] };
const BOTH_SELECTED: Config = { sync_mode: "selected", sync_projects: [SELECTED, OUTSIDE] };
const ALL_BUT_OUTSIDE: Config = { sync_mode: "all", sync_excluded: [OUTSIDE] };
const ALL: Config = { sync_mode: "all" };
const AT = "2026-09-05T12:00:00.000Z";
const PROMPT = "Add a retry to the upload job.";

const isolated = isolateCodecastDir("transcript-scope-");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-scope-"));
const previousHome = process.env.HOME;
beforeAll(() => { process.env.HOME = path.join(scratch, "home"); });
afterEach(() => setActiveConfigForTests(null));
afterAll(() => {
  process.env.HOME = previousHome;
  isolated.restore();
  fs.rmSync(scratch, { recursive: true, force: true });
});

// Records every call a pass makes to the server and accepts each one, so a
// pass the scope lets through runs to its end.
function recordingServer(): { syncService: SyncService; calls: string[] } {
  const calls: string[] = [];
  const syncService = new Proxy({} as SyncService, {
    get: (_target, method) => typeof method === "symbol" || method === "then" ? undefined : async () => {
      calls.push(method);
      return method === "createConversation" ? "conversation-created" : undefined;
    },
  });
  return { syncService, calls };
}

function expectUploaded(calls: string[]): void {
  expect(calls).toEqual(expect.arrayContaining(["createConversation", "addMessages"]));
}

const queue = strictStub<RetryQueue>("RetryQueue", {
  getPendingOperations: () => [],
  hasPendingConversation: () => false,
  add: () => "queued",
});

type Pass = (server: SyncService, conversations?: Record<string, string>) => Promise<void>;
// One agent's session on disk, as the pass that syncs it.
type Session = { pass: Pass };

function transcript(name: string, rows: unknown[]): string {
  const file = path.join(scratch, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

const codexUserMessage = (id: string, text: string) =>
  ({ type: "response_item", timestamp: AT, payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }] } });

const codexRows = (sessionId: string, cwd: string) => [
  { type: "session_meta", timestamp: AT, payload: { id: sessionId, cwd, source: "cli" } },
  codexUserMessage("m1", PROMPT),
];

function codexSession(cwd: string, dir = "codex"): { sessionId: string; file: string; pass: Pass } {
  const sessionId = randomUUID();
  const file = transcript(`${dir}/rollout-${sessionId}.jsonl`, codexRows(sessionId, cwd));
  return { sessionId, file, pass: (server, conversations = {}) => processCodexSession(file, sessionId, server, "user", undefined, conversations, queue, {}, {}, () => {}) };
}

// gemini-cli keeps a project's sessions in ~/.gemini/tmp/<project>/chats. It
// named <project> by the SHA-256 of the folder ("hash"), and now names it
// shortly and writes the folder to a .project_root file beside chats ("marker").
const geminiTmp = path.join(scratch, "gemini", "tmp");

function geminiSession(cwd: string, layout: "hash" | "marker" = "hash"): Session {
  const sessionId = randomUUID();
  const project = layout === "hash" ? createHash("sha256").update(cwd).digest("hex") : `project-${sessionId}`;
  const file = path.join(geminiTmp, project, "chats", `session-${sessionId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (layout === "marker") fs.writeFileSync(path.join(geminiTmp, project, ".project_root"), cwd);
  fs.writeFileSync(file, JSON.stringify({ sessionId, messages: [{ id: "m1", type: "user", timestamp: AT, content: PROMPT }] }));
  return { pass: (server) => processGeminiSession(file, sessionId, project, server, "user", undefined, {}, queue, {}, {}, () => {}) };
}

function opencodeSession(cwd: string): Session {
  const sessionId = opencodeRows(cwd);
  return { pass: (server) => processOpencodeSession(sessionId, server, "user", undefined, {}, queue, {}, {}, () => {}) };
}

function opencodeRows(cwd: string): string {
  const sessionId = `ses_${randomUUID().replace(/-/g, "")}`;
  const at = Date.parse(AT);
  fs.mkdirSync(path.dirname(opencodeDbPath()), { recursive: true });
  const db = new Database(opencodeDbPath());
  db.run("CREATE TABLE IF NOT EXISTS session(id TEXT,directory TEXT,title TEXT,version TEXT,project_id TEXT,slug TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT,agent TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
  db.run("INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?)", [sessionId, cwd, "Upload retry", "1", "project", "slug", at, at, null, null]);
  db.run("INSERT INTO message VALUES(?,?,?,?,?)", ["m1", sessionId, at, at, JSON.stringify({ id: "m1", sessionID: sessionId, role: "user", time: { created: at } })]);
  db.run("INSERT INTO part VALUES(?,?,?,?,?,?)", ["p1", "m1", sessionId, at, at, JSON.stringify({ id: "p1", messageID: "m1", sessionID: sessionId, type: "text", text: PROMPT })]);
  db.close();
  return sessionId;
}

function piSession(cwd: string): Session {
  const sessionId = randomUUID();
  const file = transcript(`pi/project/${sessionId}.jsonl`, [
    { type: "session", version: 3, id: sessionId, timestamp: AT, cwd },
    { type: "message", id: "m1", parentId: null, timestamp: AT, message: { role: "user", content: PROMPT } },
  ]);
  return { pass: (server) => processTranscriptDeltaSession("pi", file, sessionId, server, "user", undefined, {}, queue, {}, () => {}) };
}

function grokSession(cwd: string): Session {
  const sessionId = randomUUID();
  const file = transcript(`grok/project/${sessionId}/updates.jsonl`, [
    { timestamp: 1772550001, method: "session/update", params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: PROMPT }, _meta: { modelId: "grok-4.6", promptIndex: 0 } } } },
  ]);
  fs.writeFileSync(path.join(path.dirname(file), "summary.json"), JSON.stringify({ info: { id: sessionId, cwd } }));
  return { pass: (server) => processTranscriptDeltaSession("grok", file, sessionId, server, "user", undefined, {}, queue, {}, () => {}) };
}

function museSession(cwd: string): Session {
  const sessionId = randomUUID();
  const run = randomUUID();
  const envelope = (payload: Record<string, unknown>) => ({ schema_version: 1, id: randomUUID(), stream: { kind: "session", id: sessionId }, recorded_at: 1789742968906636, payload_type: "runtime.session", payload });
  const file = transcript(`muse/${sessionId}/session.jsonl`, [
    envelope({ kind: "route_facts", record: { cwd, pid: 1 } }),
    envelope({ kind: "run", run_id: run, event: { kind: "started", prompt: PROMPT } }),
    envelope({ kind: "run", run_id: run, event: { kind: "assistant_message_committed", message_id: "m1", text: "Added." } }),
  ]);
  return { pass: (server) => processTranscriptDeltaSession("muse", file, sessionId, server, "user", undefined, {}, queue, {}, () => {}) };
}

const AGENTS: Array<[string, (cwd: string) => Session]> = [
  ["Codex", codexSession],
  ["OpenCode", opencodeSession],
  ["pi", piSession],
  ["grok", grokSession],
  ["muse", museSession],
  ["Gemini", geminiSession],
  ["Gemini with a recorded folder", (cwd) => geminiSession(cwd, "marker")],
];

// Each scope keeps OUTSIDE out, and the one after it lets OUTSIDE in.
const SCOPE_CHANGES: Array<[string, Config, Config]> = [
  ["outside the selected projects", ONLY_SELECTED, BOTH_SELECTED],
  ["in an excluded folder", ALL_BUT_OUTSIDE, ALL],
];

for (const [agent, session] of AGENTS) {
  for (const [where, closed, open] of SCOPE_CHANGES) {
    test(`${agent}: a session ${where} is not uploaded until its folder is in scope`, async () => {
      const { pass } = session(OUTSIDE);
      const server = recordingServer();

      setActiveConfigForTests(closed);
      await pass(server.syncService);
      expect(server.calls).toEqual([]);

      setActiveConfigForTests(open);
      await pass(server.syncService);
      expectUploaded(server.calls);
    }, 90_000);
  }
}

test("Gemini: under \"all\" a hash-named session syncs unless its hash names an excluded folder", async () => {
  setActiveConfigForTests({ sync_mode: "all", excluded_paths: OUTSIDE });

  const excluded = recordingServer();
  await geminiSession(OUTSIDE).pass(excluded.syncService);
  expect(excluded.calls).toEqual([]);

  const unlisted = recordingServer();
  await geminiSession("/side/drafts").pass(unlisted.syncService);
  expectUploaded(unlisted.calls);
}, 90_000);

function claudeSession(cwd: string): string {
  const sessionId = randomUUID();
  transcript(`home/.claude/projects/${cwd.replace(/\//g, "-")}/${sessionId}.jsonl`, [
    { type: "user", sessionId, cwd, timestamp: AT, message: { role: "user", content: PROMPT } },
  ]);
  return sessionId;
}

test("the startup path repair sends the server no folder of a session outside the sync scope", async () => {
  const rollouts = "home/.codex/sessions/2026/09/06";
  const inScope = [claudeSession(SELECTED), codexSession(SELECTED, rollouts).sessionId];
  const outside = [claudeSession(OUTSIDE), codexSession(OUTSIDE, rollouts).sessionId];
  const repaired = new Map<string, string>();
  const server = strictStub<SyncService>("SyncService", {
    updateProjectPath: async (sessionId, projectPath) => {
      repaired.set(sessionId, projectPath);
      return { updated: true };
    },
  });

  await repairProjectPaths(server, ONLY_SELECTED);

  expect(inScope.map(sessionId => repaired.get(sessionId))).toEqual([SELECTED, SELECTED]);
  expect(outside.filter(sessionId => repaired.has(sessionId))).toEqual([]);
  expect([...repaired.values()].filter(projectPath => projectPath !== SELECTED)).toEqual([]);
}, 90_000);

test("Codex: a conversation gets no more messages once its folder leaves the selected projects", async () => {
  const { sessionId, file, pass } = codexSession(OUTSIDE);
  const conversations = { [sessionId]: "conversation-synced-earlier" };
  // Synced up to here while the folder was in scope. The next message is
  // written after it left, in a window that no longer holds the session_meta.
  setPosition(file, fs.statSync(file).size);
  fs.appendFileSync(file, JSON.stringify(codexUserMessage("m2", "Now cover the timeout.")) + "\n");
  const server = recordingServer();

  setActiveConfigForTests(ONLY_SELECTED);
  await pass(server.syncService, conversations);
  expect(server.calls).toEqual([]);

  setActiveConfigForTests(BOTH_SELECTED);
  await pass(server.syncService, conversations);
  expect(server.calls).toContain("addMessages");
  expect(server.calls).not.toContain("createConversation");
}, 90_000);
