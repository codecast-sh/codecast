import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTurnSnapshot, type TurnSnapshot } from "./treeSnapshot.js";
import { RewindRefused, diffRewind, keepRewind, linksAfter, planRewind, putBackRewind, readStaged, stageRewind, type RewindRow } from "./rewindTree.js";

// Real git in temp repos: slow on a loaded machine, so no 5 s default.
setDefaultTimeout(60_000);
const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch {}
  }
});
const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

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
const write = (cwd: string, f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
  fs.writeFileSync(path.join(cwd, f), s);
};
const read = (cwd: string, f: string) => (fs.existsSync(path.join(cwd, f)) ? fs.readFileSync(path.join(cwd, f), "utf8") : null);

/** A turn: run `edit`, snapshot, and return the row the daemon would record for it at moment `t`. */
async function turn(cwd: string, t: number, edit: () => void): Promise<RewindRow & { snap: TurnSnapshot }> {
  edit();
  const snap = (await createTurnSnapshot(cwd))!;
  return { sha: snap.sha, base_sha: snap.base, prev_sha: snap.prev, taken_at: t, turn_completed_at: t, shared_sessions: 0, snap };
}

/** Three turns of one session and a message just before the second: the scene most tests rewind. */
async function scene() {
  const cwd = repo();
  const t1 = await turn(cwd, 1000, () => write(cwd, "a.txt", "a turn1\n"));
  // The message the person rewinds to arrives at 1500; turn 2 answers it.
  const t2 = await turn(cwd, 2000, () => {
    write(cwd, "a.txt", "a turn2\n");
    write(cwd, "new/dir/created.txt", "created in turn2\n");
    fs.rmSync(path.join(cwd, "gone.txt"));
  });
  const t3 = await turn(cwd, 3000, () => write(cwd, "b.txt", "b turn3\n"));
  return { cwd, rows: [t1, t2, t3] };
}

describe("planRewind", () => {
  test("restores, deletes and recreates exactly the files the session's turns after the message touched", async () => {
    const { cwd, rows } = await scene();
    write(cwd, "c.txt", "a person's edit, never touched by the session\n");
    const plan = await planRewind(cwd, "conv", rows, 1500);
    expect(plan.turns).toBe(2);
    expect(plan.files.map((f) => [f.path, f.action, f.conflict])).toEqual([
      ["a.txt", "restore", false],
      ["b.txt", "restore", false],
      ["gone.txt", "recreate", false],
      ["new/dir/created.txt", "delete", false],
    ]);

    await stageRewind(plan, { fingerprint: plan.fingerprint });
    expect(read(cwd, "a.txt")).toBe("a turn1\n");
    expect(read(cwd, "b.txt")).toBe("b.txt v0\n");
    expect(read(cwd, "gone.txt")).toBe("gone.txt v0\n");
    expect(read(cwd, "new/dir/created.txt")).toBeNull();
    expect(fs.existsSync(path.join(cwd, "new"))).toBe(false);
    // Left alone: the person's edit, HEAD and the real index.
    expect(read(cwd, "c.txt")).toBe("a person's edit, never touched by the session\n");
    expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("");

    const { restored } = await putBackRewind(cwd);
    expect(restored).toBe(4);
    expect(read(cwd, "a.txt")).toBe("a turn2\n");
    expect(read(cwd, "b.txt")).toBe("b turn3\n");
    expect(read(cwd, "gone.txt")).toBeNull();
    expect(read(cwd, "new/dir/created.txt")).toBe("created in turn2\n");
    expect(await readStaged(cwd)).toBeNull();
    expect(git(cwd, ["for-each-ref", "refs/codecast/rewind"])).toBe("");
  });

  test("a file changed after the session's last turn is a conflict: refused, then overwritten on request and put back intact", async () => {
    const { cwd, rows } = await scene();
    write(cwd, "b.txt", "someone else's later edit\n");
    const plan = await planRewind(cwd, "conv", rows, 1500);
    expect(plan.files.filter((f) => f.conflict).map((f) => f.path)).toEqual(["b.txt"]);

    const refused = await stageRewind(plan, { fingerprint: plan.fingerprint }).catch((e) => e);
    expect(refused).toBeInstanceOf(RewindRefused);
    expect((refused as RewindRefused).paths).toEqual(["b.txt"]);
    expect(read(cwd, "a.txt")).toBe("a turn2\n"); // nothing moved

    await stageRewind(plan, { fingerprint: plan.fingerprint, overwrite: true });
    expect(read(cwd, "b.txt")).toBe("b.txt v0\n");
    await putBackRewind(cwd);
    expect(read(cwd, "b.txt")).toBe("someone else's later edit\n");
  });

  test("another session's snapshot in the shared chain is not the session's: its changes stay", async () => {
    const { cwd, rows } = await scene();
    // A sibling session's turn in the same checkout, between ours.
    const sibling = await turn(cwd, 3500, () => write(cwd, "c.txt", "sibling's work\n"));
    const t4 = await turn(cwd, 4000, () => write(cwd, "a.txt", "a turn4\n"));
    expect(t4.prev_sha).toBe(sibling.sha);
    const plan = await planRewind(cwd, "conv", [...rows, t4], 1500);
    expect(plan.files.map((f) => f.path)).not.toContain("c.txt");
    expect(plan.files.find((f) => f.path === "a.txt")?.to).toBe(git(cwd, ["rev-parse", `${rows[0].sha}:a.txt`]));
  });

  test("a path the sibling touched first goes back to the sibling's version, the tree before the session's own first change", async () => {
    const { cwd, rows } = await scene();
    await turn(cwd, 3500, () => write(cwd, "c.txt", "sibling's version\n"));
    const t4 = await turn(cwd, 4000, () => write(cwd, "c.txt", "ours on top\n"));
    const plan = await planRewind(cwd, "conv", [...rows, t4], 1500);
    await stageRewind(plan, { fingerprint: plan.fingerprint });
    expect(read(cwd, "c.txt")).toBe("sibling's version\n");
  });

  test("in a checkout shared at the time, a snapshot's paths count only when the session's own edits name them", async () => {
    const { cwd, rows } = await scene();
    // One turn of ours while a sibling edits c.txt in the same tree: one snapshot holds both.
    const t4 = await turn(cwd, 4000, () => {
      write(cwd, "a.txt", "a turn4\n");
      write(cwd, "c.txt", "sibling, same snapshot\n");
    });
    const shared = [...rows, { ...t4, shared_sessions: 1 }];
    const plan = await planRewind(cwd, "conv", shared, 3500, [path.join(cwd, "a.txt")]);
    expect(plan.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(plan.left_alone).toBe(1);
    // Without the session's edit list (an older backend) a shared snapshot's paths are all left alone.
    const unknown = await planRewind(cwd, "conv", shared, 3500, null);
    expect(unknown.files).toEqual([]);
    expect(unknown.left_alone).toBe(2);
  });

  test("a stale review is refused, and only one rewind is staged at a time", async () => {
    const { cwd, rows } = await scene();
    const plan = await planRewind(cwd, "conv", rows, 1500);
    write(cwd, "a.txt", "moved after the review\n");
    const fresh = await planRewind(cwd, "conv", rows, 1500);
    expect(fresh.fingerprint).not.toBe(plan.fingerprint);
    await expect(stageRewind(fresh, { fingerprint: plan.fingerprint })).rejects.toThrow(/changed since the review/);

    const clean = await planRewind(cwd, "conv", rows, 2500);
    await stageRewind(clean, { fingerprint: clean.fingerprint });
    const again = await planRewind(cwd, "conv", rows, 1500);
    await expect(stageRewind(again, { fingerprint: again.fingerprint, overwrite: true })).rejects.toThrow(/already staged/);
  });

  test("put back refuses a file edited after the rewind unless forced; keep drops the backup and leaves the rewound files", async () => {
    const { cwd, rows } = await scene();
    const plan = await planRewind(cwd, "conv", rows, 1500);
    await stageRewind(plan, { fingerprint: plan.fingerprint });
    write(cwd, "a.txt", "the fork's agent edited it\n");
    const err = await putBackRewind(cwd).catch((e) => e);
    expect((err as RewindRefused).paths).toEqual(["a.txt"]);
    expect(read(cwd, "b.txt")).toBe("b.txt v0\n"); // nothing put back yet

    const kept = await keepRewind(cwd);
    expect(kept.files.length).toBe(4);
    expect(await readStaged(cwd)).toBeNull();
    expect(read(cwd, "a.txt")).toBe("the fork's agent edited it\n");
    expect(read(cwd, "b.txt")).toBe("b.txt v0\n");
  });

  test("diff shows each file going from now to what it goes back to", async () => {
    const { cwd, rows } = await scene();
    const plan = await planRewind(cwd, "conv", rows, 1500);
    const { diff } = await diffRewind(plan);
    expect(diff).toContain("--- a/a.txt\n+++ b/a.txt");
    expect(diff).toContain("-a turn2\n+a turn1");
    expect(diff).toContain("--- a/new/dir/created.txt\n+++ /dev/null");
    expect(diff).toContain("--- /dev/null\n+++ b/gone.txt");
    const one = await diffRewind(plan, "b.txt");
    expect(one.diff).toContain("-b turn3\n+b.txt v0");
    expect(one.diff).not.toContain("a.txt");
  });

  test("a message after the last turn rewinds nothing", async () => {
    const { cwd, rows } = await scene();
    const plan = await planRewind(cwd, "conv", rows, 9999);
    expect(plan.files).toEqual([]);
    await expect(stageRewind(plan, { fingerprint: plan.fingerprint })).rejects.toThrow(/nothing to rewind/);
  });
});

describe("linksAfter", () => {
  test("a restarted chain falls back to the session's previous snapshot, and a repeated sha counts once", () => {
    const rows: RewindRow[] = [
      { sha: "s1", base_sha: "h", taken_at: 1 },
      { sha: "s2", base_sha: "h", prev_sha: "s1", taken_at: 2 },
      { sha: "s2", base_sha: "h", prev_sha: "s1", taken_at: 3 },
      { sha: "s3", base_sha: "h", taken_at: 4 },
    ];
    expect(linksAfter(rows, 1.5).map((l) => `${l.from}>${l.to}`)).toEqual(["s1>s2", "s2>s3"]);
  });
});
