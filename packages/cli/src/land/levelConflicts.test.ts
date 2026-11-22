// The merge files a level conflict's writer is handed, and the brief a raced
// level sends at once. Real git (a bare origin, a shared checkout, a clone that
// pushes upstream work) inside an isolated CODECAST_DIR and HOME; attribution
// is faked to name the writer. The held conflict's ask is checkoutReport's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SessionEdits } from "./attribute.js";
import { briefRacedStale, classifySendError, mergeDir, writeMerges, type BriefDeps } from "./levelConflicts.js";
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
const OTHER = "jx7oooooooooooooooooooooooooooo2";
const A = "one\ntwo\nthree\nfour\nfive\n";
const T = 1_800_000_000_000;

let worlds = 0;
/** An opted-in shared checkout where a session edited a.txt and b.txt; attribution is faked from `writers`. */
function world() {
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
  const upstream = (changes: Record<string, string | null>, msg: string) => {
    for (const [f, t] of Object.entries(changes)) t === null ? fs.rmSync(path.join(other, f)) : write(other, f, t);
    sh(other, "add", "-A");
    sh(other, "commit", "-qm", msg);
    sh(other, "push", "-q", "origin", "main");
    sh(shared, "fetch", "-q");
  };
  const gitDir = sh(shared, "rev-parse", "--absolute-git-dir");
  const sent: Array<{ to: string; body: string; clientId: string }> = [];
  let reply: "sent" | "failed" | "unreachable" = "sent";
  const send = async (to: string, body: string, clientId: string) => { sent.push({ to, body, clientId }); return reply; };
  const writers = new Map<string, string>();
  const attribute = (_r: string, paths: string[]) => ({ owners: new Map(paths.filter((p) => writers.has(p)).map((p) => [p, { conversationId: writers.get(p)! } as SessionEdits])) });
  return {
    shared, gitDir, upstream, sent, writers,
    reply: (v: typeof reply) => { reply = v; },
    deps: (now: number): BriefDeps => ({ send, attribute, now }),
  };
}

describe("a level conflict holding the checkout", () => {
  test("the sweep itself says nothing: the checkout report tells the writer once the level has stuck", async () => {
    const { shared, upstream, sent, writers, deps } = world();
    writers.set("a.txt", CONV);
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    const head = sh(shared, "rev-parse", "HEAD");
    const line = await sweepOne(shared, deps(T));
    expect(line).toContain("not levelled");
    expect(line).not.toContain("brief");
    expect(sh(shared, "rev-parse", "HEAD")).toBe(head);
    expect(sent).toHaveLength(0);
  }, 300_000);
});

describe("merge files", () => {
  test("a three-way merge with markers per path, upstream's version for a file deleted here, and an instruction (no file) for one upstream deleted", async () => {
    const { shared, gitDir, upstream } = world();
    const from = sh(shared, "rev-parse", "HEAD");
    upstream({ "a.txt": A.replace("one", "theirs"), "b.txt": null }, "Rework a, drop b");
    const to = sh(shared, "rev-parse", "origin/main");
    const dir = mergeDir(gitDir);
    const merges = await writeMerges(shared, dir, ["a.txt", "b.txt"], from, to);
    expect(merges.get("a.txt")).toEqual({ kind: "merged", file: path.join(dir, "a.txt") });
    const merged = fs.readFileSync(path.join(dir, "a.txt"), "utf-8");
    expect(merged).toContain("<<<<<<< yours");
    expect(merged).toContain("mine");
    expect(merged).toContain("theirs");
    expect(merges.get("b.txt")).toEqual({ kind: "upstream-deleted" });
    fs.rmSync(path.join(shared, "a.txt"));
    expect(await writeMerges(shared, dir, ["a.txt"], from, to)).toEqual(new Map([["a.txt", { kind: "local-deleted", file: path.join(dir, "a.txt") }]]));
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe(A.replace("one", "theirs"));
  }, 300_000);

  test("never throws: a path escaping the directory, a directory in the way, a binary file or a symlink each get no merge file", async () => {
    const { shared, gitDir, upstream } = world();
    const from = sh(shared, "rev-parse", "HEAD");
    upstream({ "a.txt": A.replace("one", "theirs"), "bin.dat": "x\0y" }, "Rename the first line");
    const to = sh(shared, "rev-parse", "origin/main");
    write(shared, "bin.dat", "z\0w");
    fs.symlinkSync("a.txt", path.join(shared, "link.txt"));
    const dir = mergeDir(gitDir);
    const odd = await writeMerges(shared, dir, ["../escape.txt", "bin.dat"], from, to);
    expect(odd.get("../escape.txt")).toEqual({ kind: "none" });
    expect(odd.get("bin.dat")).toEqual({ kind: "binary" });
    fs.mkdirSync(path.join(gitDir, "codecast"), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "in the way");
    expect((await writeMerges(shared, dir, ["a.txt"], from, to)).get("a.txt")).toEqual({ kind: "none" });
  }, 300_000);

  test("the ownership refusal is told apart from a transient failure", () => {
    expect(classifySendError(new Error("[Request ID: 1a2b] Server Error\nUncaught Error: Unauthorized: can only send messages to your own conversations\n    at handler"))).toBe("unreachable");
    for (const transient of [new Error("fetch failed"), Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }), new Error("[Request ID: 3c4d] Server Error"), new Error("502 Bad Gateway"), "ECONNRESET"]) {
      expect(classifySendError(transient)).toBe("failed");
    }
  });
});

describe("a level that raced a writer", () => {
  test("HEAD moved to upstream with the file left stale: its writer hears at once that the file would revert upstream's change; the merge file survives the next level and is pruned after a day", async () => {
    const { shared, gitDir, upstream, sent, writers, deps } = world();
    writers.set("a.txt", CONV);
    const from = sh(shared, "rev-parse", "HEAD");
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    const to = sh(shared, "rev-parse", "origin/main");
    const r = { ok: false, from, to, written: [], deleted: [], absorbed: [], merged: [], kept: [], conflicts: ["a.txt"], reason: "kept changing" };
    // Held (HEAD still on `from`): not this brief's to send.
    expect(await briefRacedStale(shared, gitDir, r, deps(T))).toBeNull();
    expect(sent).toHaveLength(0);

    // A level races the writer: the branch on `to`, the file as it was (what levelCheckout leaves).
    sh(shared, "update-ref", "refs/heads/main", to, from);
    expect(await briefRacedStale(shared, gitDir, r, deps(T + 60_000))).toBe(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(CONV);
    expect(sent[0].clientId).toMatch(/^level-raced:/);
    const stale = path.join(gitDir, "codecast", "level-stale", "a.txt");
    const body = sent[0].body;
    expect(body).toStartWith('<session-message from="codecast" name="level sweep">');
    expect(body).toContain(`moved to upstream ${to.slice(0, 9)}`);
    expect(body).toContain("would revert that change");
    expect(body).toContain(sh(shared, "log", "-1", "--format=%h %s", "origin/main"));
    expect(body).toContain(stale);
    expect(body).toContain("Never run git pull, merge, rebase, stash, checkout, restore, reset or commit in this shared checkout");
    expect(fs.readFileSync(stale, "utf-8")).toContain("<<<<<<< yours");

    // The next sweep finds the checkout level and clears the held merges, not the stale copy's.
    fs.mkdirSync(mergeDir(gitDir), { recursive: true });
    await sweepOne(shared, deps(T + 120_000));
    expect(fs.existsSync(mergeDir(gitDir))).toBe(false);
    expect(fs.existsSync(stale)).toBe(true);
    expect(sent).toHaveLength(1);
    // A day on, the sweep prunes it.
    const dayAgo = new Date(Date.now() - 2 * 86_400_000);
    fs.utimesSync(stale, dayAgo, dayAgo);
    await sweepOne(shared, deps(T + 180_000));
    expect(fs.existsSync(path.join(gitDir, "codecast", "level-stale"))).toBe(false);

    // Signed out: nothing attributed, the log says why.
    expect(await briefRacedStale(shared, gitDir, r, { ...deps(T), send: undefined })).toBe("cannot brief writers of a.txt: not signed in");
  }, 300_000);

  test("a teammate's session and a writerless file are named in the log line, not sent", async () => {
    const { shared, gitDir, upstream, sent, writers, reply, deps } = world();
    writers.set("a.txt", OTHER);
    const from = sh(shared, "rev-parse", "HEAD");
    upstream({ "a.txt": A.replace("one", "theirs"), "b.txt": "b upstream\n" }, "Change both");
    const to = sh(shared, "rev-parse", "origin/main");
    sh(shared, "update-ref", "refs/heads/main", to, from);
    reply("unreachable");
    const r = { ok: false, from, to, written: [], deleted: [], absorbed: [], merged: [], kept: [], conflicts: ["a.txt", "b.txt"], reason: "kept changing" };
    expect(await briefRacedStale(shared, gitDir, r, deps(T))).toBe(`${OTHER.slice(0, 7)} is a teammate's session; brief not sent (a.txt); no writer for b.txt`);
    expect(sent.map((m) => m.to)).toEqual([OTHER]);
  }, 300_000);
});
