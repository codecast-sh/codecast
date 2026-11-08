import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTurnSnapshot } from "./treeSnapshot.js";
import { RewindRefused, diffRewind, keepRewind, ownTrees, planRewind, putBackRewind, readStaged, stageRewind, type RewindRow } from "./rewindTree.js";

// Real git in temp repos: slow on a loaded machine, so no 5 s default.
setDefaultTimeout(180_000);
const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch {}
  }
});
const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
const tick = () => new Promise((r) => setTimeout(r, 5));
// Edits in these scenes happen milliseconds apart; the daemon's minute of slack would blur them together.
const SLACK = { slackMs: 1 };

function repo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-"));
  tmps.push(cwd);
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  for (const f of ["a.txt", "b.txt", "c.txt", "gone.txt"]) fs.writeFileSync(path.join(cwd, f), `${f} v0\n`);
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}
const read = (cwd: string, f: string) => (fs.existsSync(path.join(cwd, f)) ? fs.readFileSync(path.join(cwd, f), "utf8") : null);
const put = (cwd: string, f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
  fs.writeFileSync(path.join(cwd, f), s);
};

/**
 * One session in a checkout, as the daemon and the server see it: its rows
 * (prompt and turn snapshots) and its own edits with their times. A person or
 * a sibling session writes with plain `put` and snapshots with `sibling`.
 */
function session(cwd: string) {
  const rows: RewindRow[] = [];
  const edits = new Map<string, number[]>();
  const snap = async (source: "turn" | "prompt") => {
    await tick();
    const s = (await createTurnSnapshot(cwd))!;
    rows.push({ sha: s.sha, base_sha: s.base, prev_sha: s.prev, taken_at: s.takenAt, ...(source === "turn" ? { turn_completed_at: s.takenAt, source } : { source }) });
    await tick();
  };
  return {
    rows,
    get edits() { return [...edits].map(([p, at]) => ({ path: p, at })); },
    /** The person sends a message: its time, then the daemon's prompt snapshot. */
    async ask(prompt = true): Promise<number> {
      await tick();
      const at = Date.now();
      if (prompt) await snap("prompt");
      return at;
    },
    /** The session's agent writes (or deletes, with null) a file through its tools. */
    async write(f: string, s: string | null) {
      await tick();
      edits.set(f, [...(edits.get(f) ?? []), Date.now()]);
      if (s === null) fs.rmSync(path.join(cwd, f), { recursive: true, force: true });
      else put(cwd, f, s);
    },
    end: () => snap("turn"),
  };
}
/** Another session's turn end in the same checkout: a snapshot with no row of ours. */
const sibling = async (cwd: string) => { await tick(); await createTurnSnapshot(cwd); await tick(); };

/** Three turns; the person rewinds to the second message. */
async function scene() {
  const cwd = repo();
  const s = session(cwd);
  await s.ask();
  await s.write("a.txt", "a turn1\n");
  await s.end();
  const at = await s.ask();
  await s.write("a.txt", "a turn2\n");
  await s.write("new/dir/created.txt", "created in turn2\n");
  await s.write("gone.txt", null);
  await s.end();
  await s.ask();
  await s.write("b.txt", "b turn3\n");
  await s.end();
  return { cwd, s, at };
}
const plan = (cwd: string, s: ReturnType<typeof session>, at: number) => planRewind(cwd, "conv", s.rows, at, s.edits, SLACK);

describe("planRewind", () => {
  test("restores, deletes and recreates exactly the files the session's turns after the message touched", async () => {
    const { cwd, s, at } = await scene();
    put(cwd, "c.txt", "a person's edit, never touched by the session\n");
    const p = await plan(cwd, s, at);
    expect(p.turns).toBe(2);
    expect(p.from_prompt).toBe(true);
    expect(p.files.map((f) => [f.path, f.action, f.conflict])).toEqual([
      ["a.txt", "restore", false],
      ["b.txt", "restore", false],
      ["gone.txt", "recreate", false],
      ["new/dir/created.txt", "delete", false],
    ]);

    await stageRewind(p, { fingerprint: p.fingerprint });
    expect(read(cwd, "a.txt")).toBe("a turn1\n");
    expect(read(cwd, "b.txt")).toBe("b.txt v0\n");
    expect(read(cwd, "gone.txt")).toBe("gone.txt v0\n");
    expect(read(cwd, "new/dir/created.txt")).toBeNull();
    expect(fs.existsSync(path.join(cwd, "new"))).toBe(false);
    expect(read(cwd, "c.txt")).toBe("a person's edit, never touched by the session\n");
    expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("");

    expect((await putBackRewind(cwd)).restored).toBe(4);
    expect(read(cwd, "a.txt")).toBe("a turn2\n");
    expect(read(cwd, "b.txt")).toBe("b turn3\n");
    expect(read(cwd, "gone.txt")).toBeNull();
    expect(read(cwd, "new/dir/created.txt")).toBe("created in turn2\n");
    expect(await readStaged(cwd)).toBeNull();
    expect(git(cwd, ["for-each-ref", "refs/codecast/rewind"])).toBe("");
  });

  test("a file changed after the session's last turn is a conflict: refused, then overwritten on request and put back intact", async () => {
    const { cwd, s, at } = await scene();
    put(cwd, "b.txt", "someone else's later edit\n");
    const p = await plan(cwd, s, at);
    expect(p.files.filter((f) => f.conflict).map((f) => f.path)).toEqual(["b.txt"]);
    const refused = await stageRewind(p, { fingerprint: p.fingerprint }).catch((e) => e);
    expect(refused).toBeInstanceOf(RewindRefused);
    expect((refused as RewindRefused).paths).toEqual(["b.txt"]);
    expect(read(cwd, "a.txt")).toBe("a turn2\n");
    await stageRewind(p, { fingerprint: p.fingerprint, overwrite: true });
    expect(read(cwd, "b.txt")).toBe("b.txt v0\n");
    await putBackRewind(cwd);
    expect(read(cwd, "b.txt")).toBe("someone else's later edit\n");
  });

  test("a person's edit made just before the message stays, even to a file the turn then edits", async () => {
    const { cwd, s } = await scene();
    put(cwd, "c.txt", "the person's edit before asking\n");
    const at = await s.ask();
    await s.write("c.txt", "the agent's answer\n");
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.turns).toBe(1);
    await stageRewind(p, { fingerprint: p.fingerprint });
    expect(read(cwd, "c.txt")).toBe("the person's edit before asking\n");
  });

  test("a person's edit during an early turn to a file the agent only edits later stays", async () => {
    const cwd = repo();
    const s = session(cwd);
    const at = await s.ask();
    await s.write("a.txt", "agent turn1\n");
    put(cwd, "c.txt", "the person, during turn 1\n");
    await s.end();
    await s.ask();
    await s.write("c.txt", "the person's line, then the agent's\n");
    await s.end();
    const p = await plan(cwd, s, at);
    await stageRewind(p, { fingerprint: p.fingerprint });
    expect(read(cwd, "c.txt")).toBe("the person, during turn 1\n");
    expect(read(cwd, "a.txt")).toBe("a.txt v0\n");
  });

  test("uncommitted work from before the session's first turn survives", async () => {
    const cwd = repo();
    put(cwd, "a.txt", "uncommitted person work\n");
    const s = session(cwd);
    const at = await s.ask();
    await s.write("a.txt", "agent\n");
    await s.end();
    const p = await plan(cwd, s, at);
    await stageRewind(p, { fingerprint: p.fingerprint });
    expect(read(cwd, "a.txt")).toBe("uncommitted person work\n");
  });

  test("a sibling session's snapshot between the session's rows splits the timeline: its change stays, the session's own around it go", async () => {
    const { cwd, s } = await scene();
    const at = await s.ask();
    await s.write("a.txt", "ours before the sibling\n");
    put(cwd, "c.txt", "sibling's version\n");
    await sibling(cwd); // holds our half-done a.txt and the sibling's c.txt
    await s.write("c.txt", "ours on top\n");
    await s.write("b.txt", "ours after the sibling\n");
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.files.map((f) => [f.path, f.conflict])).toEqual([["a.txt", false], ["b.txt", false], ["c.txt", false]]);
    await stageRewind(p, { fingerprint: p.fingerprint });
    expect(read(cwd, "a.txt")).toBe("a turn2\n");
    expect(read(cwd, "b.txt")).toBe("b turn3\n");
    expect(read(cwd, "c.txt")).toBe("sibling's version\n");
  });

  test("the previous turn's snapshot landing after the prompt (deferred) does not swallow the session's edits", async () => {
    const cwd = repo();
    const s = session(cwd);
    await s.ask();
    await s.write("b.txt", "turn 1\n");
    const stop = Date.now();
    const at = await s.ask(); // a queued message arrives right at Stop: its prompt snapshot runs first
    await s.write("a.txt", "turn 2, before the deferred snapshot\n");
    await tick();
    const d = (await createTurnSnapshot(cwd))!; // turn 1's deferred snapshot, dated by turn 1's Stop
    s.rows.push({ sha: d.sha, base_sha: d.base, prev_sha: d.prev, taken_at: d.takenAt, turn_completed_at: stop, source: "turn" });
    await s.write("c.txt", "turn 2\n");
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.files.map((f) => f.path)).toEqual(["a.txt", "c.txt"]);
  });

  test("someone else's change between two of the session's changes to a file is a conflict", async () => {
    const { cwd, s } = await scene();
    const at = await s.ask();
    await s.write("a.txt", "ours\n");
    await s.end();
    put(cwd, "a.txt", "ours\nperson's line\n");
    await sibling(cwd);
    await s.ask();
    await s.write("a.txt", "ours again\nperson's line\n");
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.files.find((f) => f.path === "a.txt")?.conflict).toBe(true);
    await expect(stageRewind(p, { fingerprint: p.fingerprint })).rejects.toThrow(/changed since by someone else/);
  });

  test("a file the person's other session in this checkout also edited is a conflict, whatever the snapshots say", async () => {
    const { cwd, s } = await scene();
    const at = await s.ask();
    await s.write("a.txt", "ours, first\n");
    await tick();
    const theirs = Date.now();
    put(cwd, "a.txt", "ours, first\nthe sibling's line\n");
    await s.write("a.txt", "ours, second\nthe sibling's line\n");
    await s.end();
    const clean = await plan(cwd, s, at);
    expect(clean.files.find((f) => f.path === "a.txt")?.conflict).toBe(false); // the snapshots alone cannot see it
    const p = await planRewind(cwd, "conv", s.rows, at, s.edits, { ...SLACK, others: [{ path: path.join(cwd, "a.txt"), at: [theirs] }] });
    expect(p.files.find((f) => f.path === "a.txt")?.conflict).toBe(true);
  });

  test("an edit landing before the prompt snapshot finished makes that file a conflict, not a silent keep", async () => {
    const cwd = repo();
    const s = session(cwd);
    const at = await s.ask(false);
    await s.write("a.txt", "the agent was quick\n"); // before the prompt snapshot is taken
    await tick();
    const pr = (await createTurnSnapshot(cwd))!;
    s.rows.push({ sha: pr.sha, base_sha: pr.base, prev_sha: pr.prev, taken_at: pr.takenAt, source: "prompt" });
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.from_prompt).toBe(true);
    expect(p.files.map((f) => f.path)).toEqual([]); // the prompt tree already holds the edit: nothing to restore from it
    await s.ask();
    await s.write("a.txt", "and again\n");
    await s.end();
    expect((await plan(cwd, s, at)).files.find((f) => f.path === "a.txt")?.conflict).toBe(true);
  });

  test("a message that arrived mid-turn is refused: its turn began at an earlier message", async () => {
    const { cwd, s } = await scene();
    await s.ask();
    await s.write("a.txt", "working\n");
    const queued = await s.ask(false); // delivered mid-turn: no prompt hook, no snapshot
    await s.write("b.txt", "answering the queued message\n");
    await s.end();
    await expect(plan(cwd, s, queued)).rejects.toThrow(/no snapshot was taken when this message was sent/);
  });

  test("files the session's edits do not name are left alone and listed", async () => {
    const { cwd, s } = await scene();
    const at = await s.ask();
    await s.write("a.txt", "a turn4\n");
    put(cwd, "notes.md", "a person, mid-turn\n");
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(p.left_alone).toEqual(["notes.md"]);
    expect((await planRewind(cwd, "conv", s.rows, at, null, SLACK)).files).toEqual([]);
  });

  test("edited paths named through a symlinked folder, or relative to the session's folder, still count", async () => {
    const { cwd, s, at } = await scene();
    const link = path.join(os.tmpdir(), `rewind-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(cwd, link);
    tmps.push(link);
    const edits = s.edits.map((e) => (e.path === "a.txt" ? { ...e, path: path.join(link, "a.txt") } : e.path === "b.txt" ? { ...e, path: "dir/../b.txt" } : e));
    const p = await planRewind(cwd, "conv", s.rows, at, edits, { ...SLACK, cwd });
    expect(p.files.map((f) => f.path)).toEqual(["a.txt", "b.txt", "gone.txt", "new/dir/created.txt"]);
  });

  test("a file the session turned into a directory comes back as the file, and put back restores the directory", async () => {
    const cwd = repo();
    put(cwd, "x", "x as a file\n");
    const s = session(cwd);
    const at = await s.ask();
    await s.write("x", null);
    await s.write("x/inner.txt", "now a directory\n");
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.files.map((f) => [f.path, f.action])).toEqual([["x", "recreate"], ["x/inner.txt", "delete"]]);
    await stageRewind(p, { fingerprint: p.fingerprint });
    expect(read(cwd, "x")).toBe("x as a file\n");
    await putBackRewind(cwd);
    expect(read(cwd, "x/inner.txt")).toBe("now a directory\n");
  });

  test("a directory holding someone else's file is left alone rather than emptied", async () => {
    const cwd = repo();
    put(cwd, "x", "x as a file\n");
    const s = session(cwd);
    const at = await s.ask();
    await s.write("x", null);
    await s.write("x/inner.txt", "the session's\n");
    await s.end();
    put(cwd, "x/theirs.txt", "someone else's\n");
    const p = await plan(cwd, s, at);
    expect(p.files.map((f) => f.path)).toEqual(["x/inner.txt"]);
    expect(p.left_alone).toEqual(["x"]);
  });

  test("a chmod by the session is a change the rewind undoes", async () => {
    const { cwd, s } = await scene();
    const at = await s.ask();
    await s.write("b.txt", "b turn3\n");
    fs.chmodSync(path.join(cwd, "b.txt"), 0o755);
    await s.end();
    const p = await plan(cwd, s, at);
    expect(p.files.map((f) => [f.path, f.action])).toEqual([["b.txt", "restore"]]);
    await stageRewind(p, { fingerprint: p.fingerprint });
    expect(fs.statSync(path.join(cwd, "b.txt")).mode & 0o111).toBe(0);
  });

  test("an index.lock another process holds on the checkout does not stop the rewind", async () => {
    const { cwd, s, at } = await scene();
    const lock = path.join(cwd, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    try {
      const p = await plan(cwd, s, at);
      await stageRewind(p, { fingerprint: p.fingerprint });
      expect(read(cwd, "a.txt")).toBe("a turn1\n");
      await putBackRewind(cwd);
      expect(read(cwd, "a.txt")).toBe("a turn2\n");
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  test("a message older than every row returned at the cap is refused rather than rewound part way", async () => {
    const { cwd, s } = await scene();
    const last = s.rows[s.rows.length - 1];
    const many = Array.from({ length: 500 }, (_, i) => ({ ...last, taken_at: last.taken_at + 1 + i }));
    await expect(planRewind(cwd, "conv", many, last.taken_at - 10_000, s.edits)).rejects.toThrow(/more than 500 snapshots/);
  });

  test("a stale review is refused, and only one rewind is staged at a time", async () => {
    const { cwd, s, at } = await scene();
    const p = await plan(cwd, s, at);
    put(cwd, "a.txt", "moved after the review\n");
    const fresh = await plan(cwd, s, at);
    expect(fresh.fingerprint).not.toBe(p.fingerprint);
    await expect(stageRewind(fresh, { fingerprint: p.fingerprint })).rejects.toThrow(/changed since the review/);
    await stageRewind(fresh, { fingerprint: fresh.fingerprint, overwrite: true });
    const again = await plan(cwd, s, at);
    await expect(stageRewind(again, { fingerprint: again.fingerprint, overwrite: true })).rejects.toThrow(/already staged/);
  });

  test("a second step while one holds the checkout's lock is refused, not interleaved", async () => {
    const { cwd, s, at } = await scene();
    const p = await plan(cwd, s, at);
    const [a, b] = await Promise.allSettled([stageRewind(p, { fingerprint: p.fingerprint }), stageRewind(p, { fingerprint: p.fingerprint })]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect((await readStaged(cwd))?.files.length).toBe(4);
    await putBackRewind(cwd);
    expect(read(cwd, "a.txt")).toBe("a turn2\n");
  });

  test("put back refuses a file edited after the rewind unless forced; keep drops the backup and leaves the rewound files", async () => {
    const { cwd, s, at } = await scene();
    const p = await plan(cwd, s, at);
    await stageRewind(p, { fingerprint: p.fingerprint });
    put(cwd, "a.txt", "the fork's agent edited it\n");
    const err = await putBackRewind(cwd).catch((e) => e);
    expect((err as RewindRefused).paths).toEqual(["a.txt"]);
    expect(read(cwd, "b.txt")).toBe("b.txt v0\n");
    expect((await keepRewind(cwd)).files.length).toBe(4);
    expect(await readStaged(cwd)).toBeNull();
    expect(read(cwd, "a.txt")).toBe("the fork's agent edited it\n");
  });

  test("diff shows each file going from now to what it goes back to", async () => {
    const { cwd, s, at } = await scene();
    const p = await plan(cwd, s, at);
    const { diff } = await diffRewind(p);
    expect(diff).toContain("--- a/a.txt\n+++ b/a.txt");
    expect(diff).toContain("-a turn2\n+a turn1");
    expect(diff).toContain("--- a/new/dir/created.txt\n+++ /dev/null");
    expect(diff).toContain("--- /dev/null\n+++ b/gone.txt");
    const one = await diffRewind(p, "b.txt");
    expect(one.diff).toContain("-b turn3\n+b.txt v0");
    expect(one.diff).not.toContain("a.txt");
  });

  test("a message after the last turn rewinds nothing", async () => {
    const { cwd, s } = await scene();
    const p = await plan(cwd, s, await s.ask());
    expect(p.files).toEqual([]);
    await expect(stageRewind(p, { fingerprint: p.fingerprint })).rejects.toThrow(/nothing to rewind/);
  });
});

describe("ownTrees", () => {
  test("starts at the message's prompt snapshot, else the last tree before it; skips repeats; counts only turns", () => {
    const rows: RewindRow[] = [
      { sha: "s1", base_sha: "h", taken_at: 100, turn_completed_at: 100, source: "turn" },
      { sha: "p2", base_sha: "h", taken_at: 1_001, source: "prompt" },
      { sha: "s2", base_sha: "h", taken_at: 2_000, turn_completed_at: 2_000, source: "turn" },
      { sha: "s2", base_sha: "h", taken_at: 2_500, source: "sweep" },
      { sha: "s3", base_sha: "h", taken_at: 3_000, source: "sweep" },
    ];
    const withPrompt = ownTrees(rows, 1_000);
    expect(withPrompt.fromPrompt).toBe(true);
    expect(withPrompt.trees.map((t) => `${t.sha}${t.turn ? "*" : ""}`)).toEqual(["p2", "s2*", "s3"]);
    const without = ownTrees(rows.filter((r) => r.source !== "prompt"), 1_000);
    expect(without.fromPrompt).toBe(false);
    expect(without.trees.map((t) => t.sha)).toEqual(["s1", "s2", "s3"]);
  });
});
