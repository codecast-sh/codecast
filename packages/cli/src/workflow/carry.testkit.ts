/**
 * Fixtures the carry's end-to-end tests share (worktreeCarry.e2e.test.ts, branchCarry.e2e.test.ts; ct-99118): an
 * isolated HOME and CODECAST_DIR, real git, and fake transcripts the freeze reads. Each test file calls useSandbox()
 * once.
 */
import { afterAll, beforeAll } from "bun:test";
import { execFileSync } from "../proc";
import { defaultConfigDir } from "../config/configDir";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
export let sandbox = "";

/** The isolated HOME and CODECAST_DIR every test runs in, set up once per test file. */
export function useSandbox(): void {
  beforeAll(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-carry-e2e-")));
    for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
}

// The base commit is an hour old, so the transcripts' writes (seconds ago) come after it.
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
export const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

// Each test its own state dir: the sync ledger store is cached per path.
let worlds = 0;
export const freshState = () => { Object.assign(process.env, { CODECAST_DIR: path.join(sandbox, `.codecast-${++worlds}`) }); };

/** A session's transcript, and the sync ledger naming its conversation, as the freeze reads them. */
export function transcript(sessionId: string, conversationId: string, lines: object[]) {
  const dir = path.join(sandbox, ".claude", "projects", "-sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const ledgerFile = path.join(defaultConfigDir(), "sync-ledger.json");
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf-8")) : {};
  ledger[file] = { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId, sourceGeneration: { client: "claude", sessionId, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
}
const at = (ms: number) => new Date(Date.now() - ms).toISOString();
export const tool = (cwd: string, name: string, input: object, ms: number) => ({ type: "assistant", timestamp: at(ms), cwd, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name, input }] } });
