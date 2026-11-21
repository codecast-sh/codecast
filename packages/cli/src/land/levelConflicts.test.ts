// A level conflict reaches the session that wrote the file. Real git (a bare
// origin, a shared checkout, a clone that pushes upstream work) and a real
// transcript in the sync ledger, inside an isolated CODECAST_DIR and HOME.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepOne } from "./levelSweep.js";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-level-conflicts-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const CONV = "jx7wwwwwwwwwwwwwwwwwwwwwwwwwwww1";
const A = "one\ntwo\nthree\nfour\nfive\n";

let worlds = 0;
/** An opted-in shared checkout where a session edited a.txt and b.txt; `attributed` puts its transcript in the ledger. */
function world(attributed: boolean) {
  const n = ++worlds;
  process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${n}`);
  const base = path.join(sandbox, `w${n}`);
  const seed = path.join(base, "seed");
  fs.mkdirSync(seed, { recursive: true });
  sh(seed, "init", "-q", "-b", "main");
  write(seed, "a.txt", A);
  write(seed, "b.txt", "b\n");
  write(seed, ".codecast/workspace.toml", "[ship]\nlevel = true\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", "--bare", seed, path.join(base, "origin.git")]);
  const shared = path.join(base, "shared");
  const other = path.join(base, "other");
  execFileSync("git", ["clone", "-q", path.join(base, "origin.git"), shared]);
  execFileSync("git", ["clone", "-q", path.join(base, "origin.git"), other]);
  sh(shared, "remote", "set-head", "origin", "main");

  write(shared, "a.txt", A.replace("one", "mine"));
  write(shared, "b.txt", "b edited\n");
  const dir = path.join(sandbox, ".claude", "projects", `-w${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `sess-${n}.jsonl`);
  const edit = (file: string, i: number) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: shared, message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: path.join(shared, file), old_string: "x", new_string: "y" } }] } });
  fs.writeFileSync(transcript, `${edit("a.txt", 0)}\n${edit("b.txt", 1)}\n`);
  if (attributed) {
    fs.mkdirSync(process.env.CODECAST_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODECAST_DIR, "sync-ledger.json"), JSON.stringify({ [transcript]: { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: 2, conversationId: CONV, sourceGeneration: { client: "claude", sessionId: `sess-${n}`, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } } }));
  }
  const upstream = (file: string, text: string, msg: string) => {
    write(other, file, text);
    sh(other, "add", "-A");
    sh(other, "commit", "-qm", msg);
    sh(other, "push", "-q", "origin", "main");
    sh(shared, "fetch", "-q");
  };
  const gitDir = sh(shared, "rev-parse", "--absolute-git-dir");
  const sent: Array<{ to: string; body: string }> = [];
  const send = async (to: string, body: string) => { sent.push({ to, body }); return true; };
  return { shared, gitDir, upstream, sent, sweep: () => sweepOne(shared, { send }) };
}

describe("a level conflict reaches its writer", () => {
  test("briefed once per upstream sha, with the merge on disk; levelled and forgotten once the file carries upstream's change", async () => {
    const { shared, gitDir, upstream, sent, sweep } = world(true);
    upstream("a.txt", A.replace("one", "theirs"), "Rename the first line");
    const head = sh(shared, "rev-parse", "HEAD");
    const subject = sh(shared, "log", "-1", "--format=%h %s", "origin/main");

    const first = await sweep();
    expect(first).toContain("not levelled");
    expect(first).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sh(shared, "rev-parse", "HEAD")).toBe(head);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(CONV);
    const merge = path.join(gitDir, "codecast", "level-conflicts", "a.txt");
    expect(sent[0].body).toContain("a.txt");
    expect(sent[0].body).not.toContain("b.txt");
    expect(sent[0].body).toContain(subject);
    expect(sent[0].body).toContain(merge);
    const merged = fs.readFileSync(merge, "utf-8");
    expect(merged).toContain("<<<<<<< yours");
    expect(merged).toContain("mine");
    expect(merged).toContain("theirs");
    expect(merged).toContain(">>>>>>>");

    const second = await sweep();
    expect(second).toContain("already briefed");
    expect(sent).toHaveLength(1);

    upstream("c.txt", "c\n", "Add c");
    await sweep();
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toContain(sh(shared, "rev-parse", "--short=9", "origin/main"));

    // The writer brings upstream's change into its copy and keeps its own edit elsewhere.
    write(shared, "a.txt", A.replace("one", "theirs").replace("five", "mine"));
    const last = await sweep();
    expect(last).toContain("levelled");
    expect(sh(shared, "rev-parse", "HEAD")).toBe(sh(shared, "rev-parse", "origin/main"));
    expect(fs.readFileSync(path.join(shared, "a.txt"), "utf-8")).toBe(A.replace("one", "theirs").replace("five", "mine"));
    expect(fs.readFileSync(path.join(shared, "b.txt"), "utf-8")).toBe("b edited\n");
    expect(fs.existsSync(path.join(gitDir, "codecast", "level-conflicts.json"))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, "codecast", "level-conflicts"))).toBe(false);
    expect(sent).toHaveLength(2);
  }, 120_000);

  test("a conflict nobody's transcript explains sends nothing and is named in the log line", async () => {
    const { gitDir, upstream, sent, sweep } = world(false);
    upstream("a.txt", A.replace("one", "theirs"), "Rename the first line");
    const line = await sweep();
    expect(line).toContain("no writer for a.txt");
    expect(sent).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(gitDir, "codecast", "level-conflicts.json"), "utf-8")).unattributed).toEqual(["a.txt"]);
  }, 60_000);
});
