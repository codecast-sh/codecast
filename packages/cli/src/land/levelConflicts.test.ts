// A level conflict reaches the session that wrote the file. Real git (a bare
// origin, a shared checkout, a clone that pushes upstream work) and, for the
// end to end case, a real transcript in the sync ledger, inside an isolated
// CODECAST_DIR and HOME. The rest fake attribution to name the writer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attributeEdits, type SessionEdits } from "./attribute.js";
import { briefLevelConflicts, classifySendError, RETRY_MS, type BriefDeps } from "./levelConflicts.js";
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
/** An opted-in shared checkout where a session edited a.txt and b.txt; `attributed` puts its transcript in the ledger. */
function world(attributed = false) {
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
  if (attributed) {
    const dir = path.join(sandbox, ".claude", "projects", `-w${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `sess-${n}.jsonl`);
    const edit = (file: string, i: number) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: shared, message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: path.join(shared, file), old_string: "x", new_string: "y" } }] } });
    fs.writeFileSync(transcript, `${edit("a.txt", 0)}\n${edit("b.txt", 1)}\n`);
    fs.mkdirSync(process.env.CODECAST_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODECAST_DIR, "sync-ledger.json"), JSON.stringify({ [transcript]: { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: 2, conversationId: CONV, sourceGeneration: { client: "claude", sessionId: `sess-${n}`, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } } }));
  }
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
  const attributions: string[][] = [];
  /** Who wrote each path, for the faked attribution; real attribution when `real`. */
  const writers = new Map<string, string>();
  let real = attributed;
  const attribute = (r: string, paths: string[], opts: { since: number }) => {
    attributions.push([...paths]);
    if (real) return attributeEdits(r, paths, opts);
    return { owners: new Map(paths.filter((p) => writers.has(p)).map((p) => [p, { conversationId: writers.get(p)! } as SessionEdits])) };
  };
  return {
    shared, gitDir, upstream, sent, attributions, writers,
    accept: (v: boolean) => { reply = v ? "sent" : "failed"; },
    reply: (v: typeof reply) => { reply = v; },
    useReal: (v: boolean) => { real = v; },
    sweep: (now?: number, over: Partial<BriefDeps> = {}) => sweepOne(shared, { send, attribute, ...(now ? { now } : {}), ...over }),
    deps: (now: number): BriefDeps => ({ send, attribute, now }),
  };
}

const record = (gitDir: string) => JSON.parse(fs.readFileSync(path.join(gitDir, "codecast", "level-conflicts.json"), "utf-8"));

describe("a level conflict reaches its writer", () => {
  test("briefed once per upstream content of the file, as codecast's level sweep, with the merge on disk; levelled and forgotten once the file carries upstream's change", async () => {
    const { shared, gitDir, upstream, sent, attributions, sweep } = world(true);
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    const head = sh(shared, "rev-parse", "HEAD");
    const subject = sh(shared, "log", "-1", "--format=%h %s", "origin/main");

    const first = await sweep();
    expect(first).toContain("not levelled");
    expect(first).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sh(shared, "rev-parse", "HEAD")).toBe(head);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(CONV);
    expect(sent[0].clientId).toMatch(/^level-conflict:/);
    const body = sent[0].body;
    expect(body).toStartWith('<session-message from="codecast" name="level sweep">');
    const merge = path.join(gitDir, "codecast", "level-conflicts", "a.txt");
    expect(body).toContain("a.txt");
    expect(body).not.toContain("b.txt");
    expect(body).toContain(subject);
    expect(body).toContain(merge);
    expect(body).toContain("Edit only the file named here");
    expect(body).toContain("Never run git pull, merge, rebase, stash, checkout, restore, reset or commit in this shared checkout");
    const merged = fs.readFileSync(merge, "utf-8");
    expect(merged).toContain("<<<<<<< yours");
    expect(merged).toContain("mine");
    expect(merged).toContain("theirs");
    expect(merged).toContain(">>>>>>>");
    expect(attributions).toEqual([["a.txt"]]);

    const second = await sweep();
    expect(second).toContain(`already briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sent).toHaveLength(1);

    // A busy main: a commit that leaves the file alone sends nothing and attributes nothing.
    upstream({ "c.txt": "c\n" }, "Add c");
    expect(await sweep()).toContain("already briefed");
    expect(sent).toHaveLength(1);
    expect(attributions).toHaveLength(1);

    // A commit that changes the file upstream briefs its writer again.
    const upstreamA = A.replace("one", "theirs").replace("three", "THREE");
    upstream({ "a.txt": upstreamA }, "Shout the third line");
    expect(await sweep()).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toContain(sh(shared, "log", "-1", "--format=%h %s", "origin/main"));
    expect(sent[1].clientId).not.toBe(sent[0].clientId);
    expect(fs.readFileSync(merge, "utf-8")).toContain("THREE");
    expect(attributions).toHaveLength(2);

    // The writer brings upstream's change into its copy and keeps its own edit elsewhere.
    const resolved = upstreamA.replace("five", "mine");
    write(shared, "a.txt", resolved);
    const last = await sweep();
    expect(last).toContain("levelled");
    expect(sh(shared, "rev-parse", "HEAD")).toBe(sh(shared, "rev-parse", "origin/main"));
    expect(fs.readFileSync(path.join(shared, "a.txt"), "utf-8")).toBe(resolved);
    expect(fs.readFileSync(path.join(shared, "b.txt"), "utf-8")).toBe("b edited\n");
    expect(fs.existsSync(path.join(gitDir, "codecast", "level-conflicts.json"))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, "codecast", "level-conflicts"))).toBe(false);
    expect(sent).toHaveLength(2);
  }, 300_000);

  test("a conflict nobody's transcript explains sends nothing, and is asked about again every 15 minutes until its writer turns up", async () => {
    const { upstream, sent, attributions, writers, sweep } = world();
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    expect(await sweep(T)).toContain("no writer for a.txt");
    expect(sent).toHaveLength(0);
    // The writer's transcript reaches the ledger late.
    writers.set("a.txt", CONV);
    expect(await sweep(T + 60_000)).toContain("no writer for a.txt");
    expect(attributions).toHaveLength(1);
    expect(await sweep(T + RETRY_MS)).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(attributions).toHaveLength(2);
    expect(sent.map((m) => m.to)).toEqual([CONV]);
  }, 300_000);

  test("a refused brief backs off for 15 minutes and retries with the same client id; signed out, nothing is attributed", async () => {
    const { gitDir, upstream, sent, attributions, writers, accept, sweep } = world();
    writers.set("a.txt", CONV);
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");

    expect(await sweep(T, { send: undefined })).toContain("not signed in");
    expect(attributions).toHaveLength(0);
    expect(fs.existsSync(path.join(gitDir, "codecast", "level-conflicts.json"))).toBe(false);

    accept(false);
    expect(await sweep(T)).toContain(`brief failed to ${CONV.slice(0, 7)} (a.txt)`);
    expect(await sweep(T + 60_000)).not.toContain("brief failed");
    expect(sent).toHaveLength(1);
    expect(attributions).toHaveLength(1);

    accept(true);
    expect(await sweep(T + RETRY_MS)).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sent).toHaveLength(2);
    expect(sent[1].clientId).toBe(sent[0].clientId);
    expect(record(gitDir).paths["a.txt"].briefed).toBe(true);
  }, 300_000);

  test("a teammate's session the server will never deliver to is not asked again until a blob or the owner changes", async () => {
    const { shared, upstream, sent, writers, reply, sweep } = world();
    writers.set("a.txt", OTHER);
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    reply("unreachable");
    const teammate = `${OTHER.slice(0, 7)} is a teammate's session; brief not sent (a.txt)`;
    expect(await sweep(T)).toContain(teammate);
    // Same blobs, same owner, past the retry window: no send.
    expect(await sweep(T + RETRY_MS)).toContain(teammate);
    expect(sent).toHaveLength(1);
    // The file changes on disk: tried again.
    write(shared, "a.txt", A.replace("one", "theirs, edited again"));
    expect(await sweep(T + RETRY_MS + 60_000)).toContain(teammate);
    expect(sent).toHaveLength(2);
    // Same blobs, a new owner (its transcript arrived late): briefed.
    writers.set("a.txt", CONV);
    reply("sent");
    expect(await sweep(T + RETRY_MS + 120_000)).toContain(teammate);
    expect(sent).toHaveLength(2);
    expect(await sweep(T + 2 * RETRY_MS + 60_000)).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sent.map((m) => m.to)).toEqual([OTHER, OTHER, CONV]);
  }, 300_000);

  test("the ownership refusal is told apart from a transient failure", () => {
    expect(classifySendError(new Error("[Request ID: 1a2b] Server Error\nUncaught Error: Unauthorized: can only send messages to your own conversations\n    at handler"))).toBe("unreachable");
    for (const transient of [new Error("fetch failed"), Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }), new Error("[Request ID: 3c4d] Server Error"), new Error("502 Bad Gateway"), "ECONNRESET"]) {
      expect(classifySendError(transient)).toBe("failed");
    }
  });

  test("a merge file that cannot be written still briefs, and the brief is recorded so it is not sent again", async () => {
    const { gitDir, upstream, sent, writers, sweep } = world();
    writers.set("a.txt", CONV);
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    // A file where the merge directory belongs: every merge write fails with ENOTDIR.
    fs.mkdirSync(path.join(gitDir, "codecast"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "codecast", "level-conflicts"), "in the way");

    expect(await sweep(T)).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    expect(sent[0].body).toContain("No merge file could be written");
    expect(await sweep(T + 60_000)).toContain("already briefed");
    expect(sent).toHaveLength(1);
  }, 300_000);

  test("whoever writes the file now is briefed: a new writer hears, the same writer typing on does not", async () => {
    const { shared, upstream, sent, attributions, writers, sweep } = world();
    writers.set("a.txt", CONV);
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    await sweep(T);
    expect(sent.map((m) => m.to)).toEqual([CONV]);

    write(shared, "a.txt", A.replace("one", "mine, still"));
    expect(await sweep(T + 60_000)).toContain("already briefed");
    expect(attributions).toHaveLength(2);
    expect(sent).toHaveLength(1);

    writers.set("a.txt", OTHER);
    write(shared, "a.txt", A.replace("one", "someone else's"));
    expect(await sweep(T + 120_000)).toContain(`briefed ${OTHER.slice(0, 7)} (a.txt)`);
    expect(sent.map((m) => m.to)).toEqual([CONV, OTHER]);
  }, 300_000);

  test("each deletion gets its own instruction", async () => {
    const { shared, upstream, sent, writers, sweep } = world();
    writers.set("a.txt", CONV);
    writers.set("b.txt", CONV);
    // Upstream deletes b.txt, which is edited here; a.txt is deleted here and changed upstream.
    upstream({ "a.txt": A.replace("one", "theirs"), "b.txt": null }, "Rework a, drop b");
    fs.rmSync(path.join(shared, "a.txt"));
    expect(await sweep(T)).toContain(`briefed ${CONV.slice(0, 7)} (a.txt, b.txt)`);
    const body = sent[0].body;
    expect(body).toContain("Upstream deletes b.txt. Delete your copy, or move your edit to where upstream moved that code.");
    expect(body).toContain("You deleted a.txt here and upstream changed it. If it should stay, write upstream's version back over it by hand");
    const saved = body.match(/it is saved at (\S+) \(/)?.[1];
    expect(saved && fs.readFileSync(saved, "utf-8")).toBe(A.replace("one", "theirs"));
  }, 300_000);
});

describe("a level that raced a writer", () => {
  test("HEAD moved to upstream with the file left stale: its writer hears the file would revert upstream's change; the merge file survives the next level", async () => {
    const { shared, gitDir, upstream, sent, writers, deps } = world();
    writers.set("a.txt", CONV);
    const from = sh(shared, "rev-parse", "HEAD");
    upstream({ "a.txt": A.replace("one", "theirs") }, "Rename the first line");
    const to = sh(shared, "rev-parse", "origin/main");
    // What levelCheckout leaves when a file kept changing during the level: the branch on `to`, the file as it was.
    sh(shared, "update-ref", "refs/heads/main", to, from);
    const r = { ok: false, from, to, written: [], deleted: [], absorbed: [], merged: [], kept: [], conflicts: ["a.txt"], reason: "kept changing" };

    expect(await briefLevelConflicts(shared, gitDir, r, deps(T))).toContain(`briefed ${CONV.slice(0, 7)} (a.txt)`);
    const stale = path.join(gitDir, "codecast", "level-stale", "a.txt");
    expect(sent[0].body).toContain(`moved to upstream ${to.slice(0, 9)}`);
    expect(sent[0].body).toContain("would revert that change");
    expect(sent[0].body).toContain(stale);
    expect(fs.readFileSync(stale, "utf-8")).toContain("<<<<<<< yours");

    // The next sweep finds the checkout level and clears the held record, not the stale copy's merge.
    const { sweepOne: next } = await import("./levelSweep.js");
    await next(shared, deps(T + 60_000));
    expect(fs.existsSync(stale)).toBe(true);

    // HEAD neither where the level started nor where it went: nothing to say.
    write(shared, "z.txt", "z\n");
    sh(shared, "add", "z.txt");
    sh(shared, "commit", "-qm", "local");
    expect(await briefLevelConflicts(shared, gitDir, r, deps(T + 120_000))).toBeNull();
    expect(sent).toHaveLength(1);
  }, 300_000);
});
