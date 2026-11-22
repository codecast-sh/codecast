import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { antigravitySessionCwd, ensureAntigravityFolderTrusted, upsertAntigravityTrustedWorkspace } from "./antigravityLocal.js";
import { readIngestJob, ingestIdentity } from "./workers/ingestJobs.js";
import { validateIngestResult } from "./workers/ingestValidation.js";
import { transcriptDirWatcherConfig, agentSessionFromTranscriptPath } from "./transcriptDirWatcher.js";
import { scanPredicates } from "./workers/scanPolicy.js";
import type { IngestJob } from "./workers/ingestTypes.js";

const temps: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "antigravity", name), "utf8");

/** agy's data dir as 1.5.14 lays it out: brain/<id>/.system_generated/logs/
 *  transcript_full.jsonl plus conversation_summaries.db with its real columns. */
function agyDataDir(rows: { id: string; workspace: string; parent?: string; depth?: number; transcript?: string }[]): string {
  const dataDir = path.join(tempDir("agy-home-"), ".gemini", "antigravity-cli");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "conversation_summaries.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(
    "CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT \"\",`preview` text NOT NULL DEFAULT \"\",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT \"\",`source` text NOT NULL DEFAULT \"\",`project_id` text NOT NULL DEFAULT \"\",`agent_name` text NOT NULL DEFAULT \"\",`parent_conversation_id` text NOT NULL DEFAULT \"\",`nesting_depth` integer NOT NULL DEFAULT 0,`last_user_input_time` datetime NOT NULL,PRIMARY KEY (`conversation_id`))",
  );
  for (const r of rows) {
    db.query(
      "INSERT INTO conversation_summaries (conversation_id, workspace_uris, parent_conversation_id, nesting_depth, last_modified_time, last_user_input_time, status) VALUES (?, ?, ?, ?, '2026-11-22', '2026-11-22', 'CASCADE_RUN_STATUS_IDLE')",
    ).run(r.id, JSON.stringify([`file://${r.workspace.split("/").map(encodeURIComponent).join("/")}`]), r.parent ?? "", r.depth ?? 0);
    const logs = path.join(dataDir, "brain", r.id, ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), r.transcript ?? fixture("print-one-command.jsonl"));
  }
  db.close();
  // A running agy leaves its WAL database with no -shm beside it, which makes
  // SQLite refuse read-only opens; reproduce that, so the readers' fallback is
  // what these tests exercise.
  for (const side of ["-shm", "-wal"]) fs.rmSync(path.join(dataDir, `conversation_summaries.db${side}`), { force: true });
  return dataDir;
}

const transcriptOf = (dataDir: string, id: string) => path.join(dataDir, "brain", id, ".system_generated", "logs", "transcript_full.jsonl");

describe("folder trust", () => {
  test("adds the folder once and keeps every other setting", () => {
    const before = JSON.stringify({ model: "Gemini 4 Argon (High)", trustedWorkspaces: ["/Users/me"] });
    const after = upsertAntigravityTrustedWorkspace(before, "/Users/me/src/app/");
    expect(JSON.parse(after!)).toEqual({ model: "Gemini 4 Argon (High)", trustedWorkspaces: ["/Users/me", "/Users/me/src/app"] });
    expect(upsertAntigravityTrustedWorkspace(after!, "/Users/me/src/app")).toBeNull();
  });

  test("a parent in the list does not count: agy asks about each folder", () => {
    expect(upsertAntigravityTrustedWorkspace(JSON.stringify({ trustedWorkspaces: ["/Users/me"] }), "/Users/me/child")).not.toBeNull();
  });

  test("never rewrites a file it cannot read as settings", () => {
    expect(upsertAntigravityTrustedWorkspace("{not json", "/a")).toBeNull();
    expect(upsertAntigravityTrustedWorkspace("[1,2]", "/a")).toBeNull();
    expect(upsertAntigravityTrustedWorkspace(JSON.stringify({ trustedWorkspaces: "/a" }), "/b")).toBeNull();
  });

  test("writes settings.json under ~/.gemini/antigravity-cli, creating it when absent", () => {
    const home = tempDir("agy-trust-");
    expect(ensureAntigravityFolderTrusted("/work/repo", home)).toBe(true);
    expect(ensureAntigravityFolderTrusted("/work/repo", home)).toBe(false);
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
    expect(settings.trustedWorkspaces).toEqual(["/work/repo"]);
  });
});

describe("conversation_summaries.db", () => {
  // macOS's SQLite refuses a read-only open of a WAL database with no -shm
  // (measured beside a running agy); Linux's allows it, so there the readers
  // take the direct path and the tests below cover that instead.
  test.if(process.platform === "darwin")("the fixture reproduces the live state on macOS: a read-only open is refused", () => {
    const dataDir = agyDataDir([{ id: randomUUID(), workspace: "/w" }]);
    const file = path.join(dataDir, "conversation_summaries.db");
    expect(() => {
      const db = new Database(file, { readonly: true });
      try { db.query("SELECT count(*) FROM conversation_summaries").get(); } finally { db.close(); }
    }).toThrow(/unable to open database file/);
  });

  test("the daemon reads a conversation's folder for resume", () => {
    const id = randomUUID();
    const dataDir = agyDataDir([{ id, workspace: "/Users/me/My Notes" }]);
    expect(antigravitySessionCwd(transcriptOf(dataDir, id), id)).toBe("/Users/me/My Notes");
    expect(antigravitySessionCwd(transcriptOf(dataDir, id), randomUUID())).toBeUndefined();
  });

  test("the ingest worker reads the folder and turn state, and skips nothing for a top-level conversation", async () => {
    const id = randomUUID();
    const dataDir = agyDataDir([{ id, workspace: "/Users/me/scratch-agy-probe" }]);
    const file = transcriptOf(dataDir, id);
    const job: IngestJob = { client: "antigravity", file, sessionId: id, offset: 0, generation: randomUUID(), identity: ingestIdentity(fs.statSync(file)) };
    const result = await readIngestJob(job);
    await expect(validateIngestResult(result, job)).resolves.toBeDefined();
    expect(result.messages.map((m) => m.uuid)).toEqual(["agy-u0", "agy-a1", "agy-a3"]);
    expect(result.metadata.cwd).toBe("/Users/me/scratch-agy-probe");
    expect(result.metadata.turn).toBe("idle");
    expect(result.metadata.internal).toBeUndefined();
  });

  test("a conversation another one started is marked internal, and a missing database costs only the folder", async () => {
    const parent = randomUUID();
    const child = randomUUID();
    const dataDir = agyDataDir([{ id: parent, workspace: "/w" }, { id: child, workspace: "/w", parent, depth: 1 }]);
    const childFile = transcriptOf(dataDir, child);
    const childResult = await readIngestJob({ client: "antigravity", file: childFile, sessionId: child, offset: 0, generation: randomUUID(), identity: ingestIdentity(fs.statSync(childFile)) });
    expect(childResult.metadata.internal).toBe(true);

    fs.rmSync(path.join(dataDir, "conversation_summaries.db"));
    const parentFile = transcriptOf(dataDir, parent);
    const bare = await readIngestJob({ client: "antigravity", file: parentFile, sessionId: parent, offset: 0, generation: randomUUID(), identity: ingestIdentity(fs.statSync(parentFile)) });
    expect(bare.messages).toHaveLength(3);
    expect(bare.metadata.cwd).toBeUndefined();
    expect(bare.metadata.warnings.some((w) => w.startsWith("antigravity summary"))).toBe(true);
  });
});

describe("watching brain/", () => {
  test("the watcher, the scan worker and the path lookup agree on the one file per conversation", () => {
    const id = randomUUID();
    const dataDir = agyDataDir([{ id, workspace: "/w" }]);
    const base = path.join(dataDir, "brain");
    const config = transcriptDirWatcherConfig("antigravity", base);
    const { dirFilter, fileFilter } = scanPredicates(base, config.scanPolicy!);
    const rel = path.join(id, ".system_generated", "logs", "transcript_full.jsonl");
    for (const dir of [id, path.join(id, ".system_generated"), path.join(id, ".system_generated", "logs")]) {
      expect(config.dirFilter!(dir)).toBe(true);
      expect(dirFilter(dir)).toBe(true);
    }
    for (const dir of [path.join(id, "scratch"), path.join(id, ".system_generated", "steps"), path.join(id, ".system_generated", "logs", "chunks"), "not-a-uuid"]) {
      expect(config.dirFilter!(dir)).toBe(false);
      expect(dirFilter(dir)).toBe(false);
    }
    expect(config.watchFilter(rel)).toBe(true);
    expect(fileFilter(rel)).toBe(true);
    expect(config.watchFilter(path.join(id, ".system_generated", "logs", "transcript.jsonl"))).toBe(false);
    expect(fileFilter(path.join(id, ".system_generated", "logs", "transcript.jsonl"))).toBe(false);
    expect(config.extractSessionId(path.join(base, rel))).toBe(id);
  });

  test("a process holding a real install's transcript open names its conversation", () => {
    const id = randomUUID();
    const file = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain", id, ".system_generated", "logs", "transcript_full.jsonl");
    expect(agentSessionFromTranscriptPath(file)).toEqual({ agentType: "antigravity", sessionId: id });
  });
});
