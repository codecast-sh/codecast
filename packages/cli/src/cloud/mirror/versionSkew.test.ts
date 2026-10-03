import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyMirrorBundle, readStamp, verifyMirrorStamp, withMirrorLock, type ApplyResult } from "./apply";
import { parseMirrorBundle, sha256 } from "./bundle";
import { buildHomeMirror, mirrorHomeToHost, resetBuildCache, runMirrorTick, type LocalMirrorStamps, type MirrorDeps } from "./push";

// Version skew between the laptop's mirror and a host's receiver (red-list #11,
// ct-55711). The laptop runs the mirror from source, so a narrower discovery
// rule is live on its next tick while a host's receiver can be a release
// behind. On 2026-09-29 that pairing deleted hundreds of tracked files from
// every cloud checkout, three times. Laptop N+1 narrows a repo to agent
// context only for a host whose receiver said "keeps-tracked"; laptop N always
// sends the wide set. Receiver N+1 is apply.ts as it is. Receiver N is the
// same apply with the capability gone and the old prune: a project file the
// bundle stopped carrying is deleted when its bytes are still the mirror's,
// and reported as a conflict otherwise. Its --verify read reports no
// capabilities, whatever stamp a newer receiver left on disk.

type Receiver = "N" | "N+1";
type Laptop = "N" | "N+1";

const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) fs.rmSync(p, { force: true, recursive: true }); resetBuildCache(); });

const temp = () => { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-skew-"))); scratch.push(p); return p; };
const write = (root: string, rel: string, text: string) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const lines = (out: string) => out.split("\n").filter(Boolean);

const TRACKED: Record<string, string> = {
  "AGENTS.md": "project rules\n",
  "README.md": "readme\n",
  "CHANGELOG.md": "changelog\n",
  "docs/guide.md": "guide\n",
  ".github/workflows/ci.yml": "name: ci\n",
  ".gitignore": "*.local.md\n",
};

function world() {
  const local = temp();
  const remote = temp();
  const sourceRoot = path.join(local, "src", "app");
  const targetRoot = path.join(remote, "work", "app");
  for (const [rel, text] of Object.entries(TRACKED)) write(sourceRoot, rel, text);
  execFileSync("git", ["init", "-q", sourceRoot]);
  git(sourceRoot, "add", ".");
  git(sourceRoot, "commit", "-qm", "initial");
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  execFileSync("git", ["clone", "-q", sourceRoot, targetRoot]);
  // Laptop-only work the wide rule carries: an uncommitted edit, a new doc, gitignored notes.
  write(sourceRoot, "docs/guide.md", "guide, edited on the laptop\n");
  write(sourceRoot, "docs/plan.md", "a plan in progress\n");
  write(sourceRoot, "docs/notes.local.md", "gitignored notes\n");
  const host = { address: "skew.invalid", user: "u", keyPath: "/unused", homeDir: remote, remoteBaseDir: path.join(remote, "work") };
  const projects = [{ host: "u@skew.invalid", sourceRoot, targetRoot }];
  return { local, remote, sourceRoot, targetRoot, host, projects };
}

function harness(w: ReturnType<typeof world>) {
  let stamps: LocalMirrorStamps = {};
  const state = { laptop: "N+1" as Laptop, receiver: "N" as Receiver };
  /** Tracked project files a receiver deleted, by its own rule. */
  const deleted: string[] = [];
  /** The project paths each push carried, in order. */
  const carried: Array<{ laptop: Laptop; receiver: Receiver; paths: string[] }> = [];
  const projectPrefix = path.posix.relative(w.remote, w.targetRoot) + "/";
  const tracked = () => new Set(lines(git(w.targetRoot, "ls-files")).map((rel) => projectPrefix + rel));
  const deps: Partial<MirrorDeps> = {
    listHosts: async () => [w.host],
    readConfig: () => ({ user_id: "u" }),
    readProjects: () => w.projects,
    readLocalStamps: () => structuredClone(stamps),
    writeLocalStamps: (next) => { stamps = next; },
    // Laptop N has no narrow rule: it carries the wide set whatever the host says.
    build: (opts) => buildHomeMirror({ ...opts, ...(state.laptop === "N" ? { narrowProjects: false } : {}), home: w.local, deviceId: "d", gitEnv: { GIT_CONFIG_GLOBAL: path.join(w.local, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } }),
    readStamp: async () => {
      const stamp = verifyMirrorStamp(w.remote);
      if (!stamp || state.receiver === "N+1") return stamp;
      const { capabilities: _, ...older } = stamp;
      return older;
    },
    push: async (_host, bytes) => {
      const parsed = await parseMirrorBundle(bytes);
      carried.push({ laptop: state.laptop, receiver: state.receiver, paths: parsed.files.map((f) => f.path).filter((p) => p.startsWith(projectPrefix)).sort() });
      const before = readStamp(w.remote);
      const trackedBefore = tracked();
      const result = await withMirrorLock(w.remote, () => applyMirrorBundle(parsed, { home: w.remote, configUserId: "u", previousStamp: before, refresh: () => {} }));
      for (const rel of result.pruned) if (trackedBefore.has(rel)) deleted.push(rel);
      if (state.receiver === "N+1") return { pushed: true, hash: result.hash, result };
      const { capabilities: _, released = [], ...older } = result;
      const old: ApplyResult = { ...older, pruned: [...older.pruned], host_edited: [...older.host_edited] };
      for (const rel of released) {
        const info = before?.files[rel];
        const abs = path.join(w.remote, rel);
        if (!info || info.removed || !fs.existsSync(abs)) continue;
        if (sha256(fs.readFileSync(abs)) !== info.written) { old.host_edited.push(rel); continue; }
        fs.unlinkSync(abs);
        old.pruned.push(rel);
        deleted.push(rel);
      }
      if (old.host_edited.length) old.hash = "";
      return { pushed: true, hash: result.hash, result: old };
    },
  };
  const push = async () => {
    resetBuildCache();
    const outcome = await mirrorHomeToHost(w.host, { deps });
    expect(outcome.reason).toBeUndefined();
    expect(outcome.pushed).toBe(true);
    return outcome;
  };
  const inStep = async () => {
    const tick = await runMirrorTick({ reason: "test", verifyRemote: true }, deps);
    expect(tick.failed).toEqual([]);
    expect(tick.pushed).toEqual([]);
    const stamp = verifyMirrorStamp(w.remote);
    expect(stamp?.complete).toBe(true);
    expect(stamp?.hash).toBe(stamps[`${w.host.user}@${w.host.address}`]!.hash);
    expect(read(w.targetRoot, "AGENTS.md")).toBe(read(w.sourceRoot, "AGENTS.md"));
  };
  const noTrackedLost = () => {
    expect(deleted).toEqual([]);
    expect(lines(git(w.targetRoot, "ls-files", "--deleted"))).toEqual([]);
  };
  return { state, carried, deleted, push, inStep, noTrackedLost, keepsTracked: () => !!stamps[`${w.host.user}@${w.host.address}`]?.keeps_tracked };
}

test("laptop N+1 and host N: the laptop keeps the wide set, nothing tracked is deleted, and the two converge", async () => {
  const w = world();
  const h = harness(w);
  await h.push();
  expect(h.carried[0]!.paths).toContain("work/app/docs/guide.md");
  write(w.sourceRoot, "AGENTS.md", "project rules, revised\n");
  await h.push();
  expect(h.keepsTracked()).toBe(false);
  expect(h.carried[1]!.paths).toEqual(h.carried[0]!.paths);
  h.noTrackedLost();
  expect(read(w.targetRoot, "docs/guide.md")).toBe("guide, edited on the laptop\n");
  await h.inStep();
}, 60_000);

test("laptop N and host N+1: the wide set lands, nothing tracked is deleted, and the two converge", async () => {
  const w = world();
  const h = harness(w);
  h.state.laptop = "N";
  h.state.receiver = "N+1";
  await h.push();
  write(w.sourceRoot, "AGENTS.md", "project rules, revised\n");
  await h.push();
  expect(h.carried.every((c) => c.paths.includes("work/app/docs/guide.md"))).toBe(true);
  h.noTrackedLost();
  await h.inStep();
}, 60_000);

test("host upgraded N to N+1 under laptop N+1: the laptop narrows only after the receiver says keeps-tracked, and tracked files are released, not deleted", async () => {
  const w = world();
  const h = harness(w);
  await h.push();
  expect(h.keepsTracked()).toBe(false);
  h.state.receiver = "N+1";
  write(w.sourceRoot, "AGENTS.md", "project rules, revised\n");
  await h.push();
  // The upgrade is learned from the --verify read just before this push, so this push is already narrow.
  expect(h.carried[1]!.paths).not.toContain("work/app/docs/guide.md");
  expect(h.carried[1]!.paths).toContain("work/app/AGENTS.md");
  expect(h.keepsTracked()).toBe(true);
  write(w.sourceRoot, "AGENTS.md", "project rules, third revision\n");
  await h.push();
  expect(h.carried[2]!.paths).toEqual(h.carried[1]!.paths);
  h.noTrackedLost();
  // Released, not deleted: the laptop's edit stays on the host until the folder sync or a commit moves it.
  expect(read(w.targetRoot, "docs/guide.md")).toBe("guide, edited on the laptop\n");
  expect(read(w.targetRoot, "README.md")).toBe("readme\n");
  await h.inStep();
  // Laptop rolled back to N: the wide set comes back to a receiver that keeps tracked files; still nothing deleted.
  h.state.laptop = "N";
  write(w.sourceRoot, "AGENTS.md", "project rules, fourth revision\n");
  await h.push();
  h.noTrackedLost();
  await h.inStep();
}, 60_000);

// ct-56327 (under ct-55689, pl-810). A host that runs receiver N again after
// the laptop learned keeps-tracked (cast reinstalled from an older release, a
// VM rolled back, an instance replaced at the same address) still holds the
// stamp the wide push wrote, which owns tracked files. The laptop decides the
// bundle from the --verify read the installed receiver answers, not from what
// an earlier receiver said, so it sends the wide set and receiver N deletes
// nothing.
test("host back on N after the laptop learned keeps-tracked: the laptop sends the wide set, nothing tracked is deleted, and the two converge", async () => {
  const w = world();
  const h = harness(w);
  h.state.receiver = "N+1";
  await h.push();
  expect(h.keepsTracked()).toBe(true);
  write(w.sourceRoot, "AGENTS.md", "project rules, revised\n");
  await h.push();
  expect(h.carried[1]!.paths).not.toContain("work/app/docs/guide.md");
  h.state.receiver = "N";
  write(w.sourceRoot, "AGENTS.md", "project rules, third revision\n");
  await h.push();
  expect(h.carried[2]!.paths).toContain("work/app/docs/guide.md");
  expect(h.carried[2]!.paths).toContain("work/app/README.md");
  expect(h.keepsTracked()).toBe(false);
  h.noTrackedLost();
  expect(read(w.targetRoot, "README.md")).toBe("readme\n");
  await h.inStep();
}, 60_000);

test("host back on N straight after a wide push: the laptop's last answer says keeps-tracked, the fresh read does not, and the wide set goes", async () => {
  const w = world();
  const h = harness(w);
  h.state.receiver = "N+1";
  await h.push();
  expect(h.keepsTracked()).toBe(true);
  expect(h.carried[0]!.paths).toContain("work/app/docs/guide.md");
  h.state.receiver = "N";
  write(w.sourceRoot, "AGENTS.md", "project rules, revised\n");
  await h.push();
  expect(h.carried[1]!.paths).toContain("work/app/docs/guide.md");
  h.noTrackedLost();
  await h.inStep();
}, 60_000);
