import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSyncWorktree, resolveConflicts, syncTick, type HostSide, type SyncState } from "./liveSync";
import { runSide, type LandResult, type SnapshotResult } from "./syncSide";

// Each tick spawns a few dozen git processes; a loaded machine needs the room.
setDefaultTimeout(90_000);

let root: string;
let laptopRepo: string;
let hostDir: string;
let local: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
const put = (dir: string, rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const read = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf-8") : null;
const commit = (dir: string, msg: string) => { git(dir, "add", "-A"); git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg); };

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-sync-")));
  laptopRepo = path.join(root, "laptop");
  hostDir = path.join(root, "host");
  fs.mkdirSync(laptopRepo);
  git(laptopRepo, "init", "-q", "-b", "main");
  put(laptopRepo, ".gitignore", "node_modules/\n.env\n");
  put(laptopRepo, "a.txt", "1\n2\n3\n4\n5\n");
  put(laptopRepo, "b.txt", "b\n");
  commit(laptopRepo, "base");
  execFileSync("git", ["clone", "-q", laptopRepo, hostDir]);
  local = await ensureSyncWorktree(laptopRepo, "sync-c1");
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** The host is a local clone driven by the same program ssh would run there. */
function hostSide(hooks: { beforeLand?: () => void; afterLand?: () => void } = {}): HostSide {
  return {
    snapshot: () => runSide<SnapshotResult>({ op: "snapshot", cwd: hostDir, commit: true, ref: "refs/codecast/sync/c1" }),
    land: async (sha, expectTree) => {
      hooks.beforeLand?.();
      const r = await runSide<LandResult>({ op: "land", cwd: hostDir, sha, expectTree });
      hooks.afterLand?.();
      return r;
    },
    fetch: async () => { git(local, "fetch", "-q", hostDir, "+refs/codecast/sync/c1:refs/codecast/sync/c1"); },
    send: async (sha) => { git(local, "push", "-q", "--force", hostDir, `${sha}:refs/codecast/sync/c1-laptop`); },
  };
}
const opts = { name: "c1" };

describe("two-way", () => {
  test("the first tick brings the host's folder here, gitignored files included and dependencies left", async () => {
    put(hostDir, "a.txt", "host\n");
    put(hostDir, ".env", "K=1\n");
    put(hostDir, "node_modules/x.js", "built\n");
    const state: SyncState = {};
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "synced", first: true });
    expect(read(local, "a.txt")).toBe("host\n");
    expect(read(local, ".env")).toBe("K=1\n");
    expect(read(local, "node_modules/x.js")).toBeNull();
    expect(await syncTick(local, state, hostSide(), opts)).toEqual({ kind: "idle" });
  });

  test("a laptop edit reaches the host, a new gitignored file and a deletion too, and nothing is staged there", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "b.txt", "from laptop\n");
    put(local, ".env", "LAPTOP=1\n");
    put(local, "c.txt", "new\n");
    fs.rmSync(path.join(local, "a.txt"));
    const r = await syncTick(local, state, hostSide(), opts);
    expect(r).toMatchObject({ kind: "synced", toLaptop: [] });
    expect(read(hostDir, "b.txt")).toBe("from laptop\n");
    expect(read(hostDir, ".env")).toBe("LAPTOP=1\n");
    expect(read(hostDir, "c.txt")).toBe("new\n");
    expect(read(hostDir, "a.txt")).toBeNull();
    expect(git(hostDir, "diff", "--cached", "--name-only")).toBe("");
    expect(await syncTick(local, state, hostSide(), opts)).toEqual({ kind: "idle" });
  });

  test("the host's commits move the laptop copy's HEAD with them", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(hostDir, "b.txt", "committed on host\n");
    commit(hostDir, "host work");
    await syncTick(local, state, hostSide(), opts);
    expect(git(local, "rev-parse", "HEAD")).toBe(git(hostDir, "rev-parse", "HEAD"));
    expect(git(local, "status", "--porcelain")).toBe("");
  });

  test("edits to different files on both sides reach both", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "b.txt", "laptop\n");
    put(hostDir, "c.txt", "host\n");
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "synced" });
    for (const d of [local, hostDir]) { expect(read(d, "b.txt")).toBe("laptop\n"); expect(read(d, "c.txt")).toBe("host\n"); }
  });

  test("edits to different lines of one file merge on both", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "a.txt", "ONE\n2\n3\n4\n5\n");
    put(hostDir, "a.txt", "1\n2\n3\n4\nFIVE\n");
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "synced" });
    expect(read(local, "a.txt")).toBe("ONE\n2\n3\n4\nFIVE\n");
    expect(read(hostDir, "a.txt")).toBe("ONE\n2\n3\n4\nFIVE\n");
    expect(await syncTick(local, state, hostSide(), opts)).toEqual({ kind: "idle" });
  });

  test("a conflict holds only its file, each side keeps its version, it stays put, and a pick settles it", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "a.txt", "laptop line\n");
    put(hostDir, "a.txt", "host line\n");
    put(hostDir, "b.txt", "flows anyway\n");
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "conflict", paths: ["a.txt"] });
    expect(read(local, "a.txt")).toBe("laptop line\n");
    expect(read(hostDir, "a.txt")).toBe("host line\n");
    expect(read(local, "b.txt")).toBe("flows anyway\n");
    // Stable: the next tick neither flips a side nor loses the conflict.
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "conflict", paths: ["a.txt"] });
    expect(read(hostDir, "a.txt")).toBe("host line\n");
    expect(state.conflicts).toEqual(["a.txt"]);

    expect(await resolveConflicts(local, state, hostSide(), "laptop")).toEqual({ resolved: ["a.txt"] });
    expect(read(hostDir, "a.txt")).toBe("laptop line\n");
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "synced" });
    expect(state.conflicts).toEqual([]);
    expect(await syncTick(local, state, hostSide(), opts)).toEqual({ kind: "idle" });
  });

  test("keeping the cloud's version lands it here", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "a.txt", "laptop line\n");
    put(hostDir, "a.txt", "host line\n");
    await syncTick(local, state, hostSide(), opts);
    await resolveConflicts(local, state, hostSide(), "cloud");
    expect(read(local, "a.txt")).toBe("host line\n");
    await syncTick(local, state, hostSide(), opts);
    expect(await syncTick(local, state, hostSide(), opts)).toEqual({ kind: "idle" });
    expect(read(hostDir, "a.txt")).toBe("host line\n");
  });
});

describe("conflict shapes", () => {
  test("deleted on one side and edited on the other holds, each side as it is, until picked", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    fs.rmSync(path.join(local, "b.txt"));
    put(hostDir, "b.txt", "host kept editing\n");
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "conflict", paths: ["b.txt"] });
    expect(read(local, "b.txt")).toBeNull();
    expect(read(hostDir, "b.txt")).toBe("host kept editing\n");
    await resolveConflicts(local, state, hostSide(), "laptop", ["b.txt"]);
    expect(read(hostDir, "b.txt")).toBeNull();
    await syncTick(local, state, hostSide(), opts);
    expect(await syncTick(local, state, hostSide(), opts)).toEqual({ kind: "idle" });
  });

  test("a binary file changed on both sides holds without markers", async () => {
    put(laptopRepo, "img.bin", "\0\x01base");
    commit(laptopRepo, "bin");
    git(hostDir, "pull", "-q");
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "img.bin", "\0\x01laptop");
    put(hostDir, "img.bin", "\0\x01host");
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "conflict", paths: ["img.bin"] });
    expect(read(local, "img.bin")).toBe("\0\x01laptop");
    expect(read(hostDir, "img.bin")).toBe("\0\x01host");
  });
});

describe("races", () => {
  test("a host edit made mid-tick is never overwritten; the next tick carries both", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "b.txt", "laptop\n");
    let once = true;
    const racing = hostSide({ beforeLand: () => { if (once) { once = false; put(hostDir, "c.txt", "agent wrote this just now\n"); } } });
    expect(await syncTick(local, state, racing, opts)).toEqual({ kind: "retry", side: "host" });
    expect(read(hostDir, "b.txt")).toBe("b\n");
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "synced" });
    for (const d of [local, hostDir]) { expect(read(d, "b.txt")).toBe("laptop\n"); expect(read(d, "c.txt")).toBe("agent wrote this just now\n"); }
  });

  test("a laptop edit made after the host took the merge is kept, and the host's side is not undone", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), opts);
    put(local, "b.txt", "laptop\n");
    put(hostDir, "c.txt", "host\n");
    let once = true;
    const racing = hostSide({ afterLand: () => { if (once) { once = false; put(local, "d.txt", "typed during the tick\n"); } } });
    expect(await syncTick(local, state, racing, opts)).toEqual({ kind: "retry", side: "laptop" });
    expect(await syncTick(local, state, hostSide(), opts)).toMatchObject({ kind: "synced" });
    for (const d of [local, hostDir]) {
      expect(read(d, "b.txt")).toBe("laptop\n");
      expect(read(d, "c.txt")).toBe("host\n");
      expect(read(d, "d.txt")).toBe("typed during the tick\n");
    }
  });
});

describe("watch only", () => {
  test("an edit in the laptop copy stops the sync and names the file", async () => {
    const state: SyncState = {};
    await syncTick(local, state, hostSide(), { ...opts, mode: "from_cloud" });
    put(local, "b.txt", "mine\n");
    put(hostDir, "a.txt", "host moves on\n");
    expect(await syncTick(local, state, hostSide(), { ...opts, mode: "from_cloud" })).toEqual({ kind: "local_edit", files: ["b.txt"] });
    expect(read(local, "a.txt")).toBe("1\n2\n3\n4\n5\n");
    expect(read(hostDir, "b.txt")).toBe("b\n");
  });
});
