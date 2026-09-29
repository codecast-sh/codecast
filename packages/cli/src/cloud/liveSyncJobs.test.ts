import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LiveSyncJobs, MIRROR_ACTIVE_WINDOW_MS, MIRROR_ACTIVITY_POLL_MS, MIRROR_LAPTOP_CHECK_MS, type MirrorActivity, type MirrorReport } from "./liveSyncJobs";
import type { HostSide } from "./liveSync";
import { runSide, type LandResult, type SnapshotResult } from "./syncSide";

setDefaultTimeout(90_000);

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
const read = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-jobs-")));
  fs.mkdirSync(path.join(dir, "laptop"));
  git(path.join(dir, "laptop"), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "laptop/a.txt"), "a\n");
  git(path.join(dir, "laptop"), "add", "-A");
  git(path.join(dir, "laptop"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", path.join(dir, "laptop"), path.join(dir, "host")]);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const reports: MirrorReport[] = [];
  let clock = 1_000_000;
  let hostCalls = 0;
  const activity: MirrorActivity = { conversation_id: "conv1", message_count: 5, status: "active", owner_device_id: "host-dev", host_online: true };
  const host = path.join(dir, "host");
  const jobs = new LiveSyncJobs({
    report: async (_id, r) => { reports.push(r); },
    activity: async () => [{ ...activity }],
    hostFor: () => ({ address: "h", user: "u", keyPath: "k", remoteBaseDir: "/w" } as any),
    log: () => {},
    jobsFile: path.join(dir, "jobs.json"),
    now: () => clock,
    hostSide: (_spec, _h, local): HostSide => ({
      snapshot: () => { hostCalls++; return runSide<SnapshotResult>({ op: "snapshot", cwd: host, commit: true, ref: "refs/codecast/sync/conv1" }); },
      land: (sha, expectTree) => { hostCalls++; return runSide<LandResult>({ op: "land", cwd: host, sha, expectTree }); },
      fetch: async () => { git(local, "fetch", "-q", host, "+refs/codecast/sync/conv1:refs/codecast/sync/conv1"); },
      send: async (sha) => { git(local, "push", "-q", "--force", host, `${sha}:refs/codecast/sync/conv1-laptop`); },
    }),
  });
  return { jobs, reports, activity, host, advance: (ms: number) => { clock += ms; }, hostCalls: () => hostCalls };
}
const spec = () => ({ conversation_id: "conv1", host_device_id: "host-dev", remote_cwd: "/w/r", local_root: path.join(dir, "laptop") });
const mirrorDir = () => path.join(dir, "laptop/.codecast/worktrees/sync-conv1");

test("syncs both ways while the session works, pauses without touching the host when it idles, resumes when it works again", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true });
  fs.writeFileSync(path.join(h.host, "a.txt"), "host edit\n");
  await h.jobs.pass();
  expect(read(path.join(mirrorDir(), "a.txt"))).toBe("host edit\n");
  expect(h.reports.map((r) => r.status)).toEqual(["starting", "live"]);
  expect(h.reports[1]).toMatchObject({ path: mirrorDir(), mode: "two_way" });

  fs.writeFileSync(path.join(mirrorDir(), "b.txt"), "from the laptop\n");
  h.advance(5_000); await h.jobs.pass();
  expect(read(path.join(h.host, "b.txt"))).toBe("from the laptop\n");
  expect(h.reports.at(-1)).toMatchObject({ status: "live", to_host: 1, to_laptop: 0 });

  h.advance(MIRROR_ACTIVE_WINDOW_MS + MIRROR_ACTIVITY_POLL_MS);
  await h.jobs.pass();
  expect(h.reports.at(-1)!.status).toBe("paused");
  const calls = h.hostCalls();
  h.advance(MIRROR_LAPTOP_CHECK_MS); await h.jobs.pass();
  expect(h.hostCalls()).toBe(calls);

  h.activity.message_count = 9;
  h.advance(MIRROR_ACTIVITY_POLL_MS);
  fs.writeFileSync(path.join(h.host, "c.txt"), "new\n");
  await h.jobs.pass();
  expect(read(path.join(mirrorDir(), "c.txt"))).toBe("new\n");
  expect(h.reports.at(-1)).toMatchObject({ status: "live", to_laptop: 1 });
  await h.jobs.stop("conv1");
});

test("a laptop edit made while the session idles reaches an awake host, and never wakes a sleeping one", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true });
  await h.jobs.pass();
  h.advance(MIRROR_ACTIVE_WINDOW_MS + MIRROR_ACTIVITY_POLL_MS);
  h.activity.host_online = false;
  await h.jobs.pass();
  fs.writeFileSync(path.join(mirrorDir(), "idle.txt"), "typed while idle\n");
  const calls = h.hostCalls();
  h.advance(MIRROR_ACTIVITY_POLL_MS); await h.jobs.pass();
  expect(h.hostCalls()).toBe(calls);
  expect(read(path.join(h.host, "idle.txt"))).toBeNull();

  h.activity.host_online = true;
  h.advance(MIRROR_ACTIVITY_POLL_MS); await h.jobs.pass();
  expect(read(path.join(h.host, "idle.txt"))).toBe("typed while idle\n");
  await h.jobs.stop("conv1");
});

test("a conflict is reported with its files, and a pick from the web settles it", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true });
  await h.jobs.pass();
  fs.writeFileSync(path.join(mirrorDir(), "a.txt"), "laptop\n");
  fs.writeFileSync(path.join(h.host, "a.txt"), "host\n");
  h.advance(5_000); await h.jobs.pass();
  expect(h.reports.at(-1)).toMatchObject({ status: "conflict", conflicts: ["a.txt"] });
  await h.jobs.handleCommand({ ...spec(), enable: true, resolve: { keep: "cloud" } });
  expect(read(path.join(mirrorDir(), "a.txt"))).toBe("host\n");
  h.advance(5_000); await h.jobs.pass();
  expect(h.reports.at(-1)).toMatchObject({ status: "live", conflicts: [] });
  await h.jobs.stop("conv1");
});

test("watch only: an edit in the laptop copy stops it; overwrite keeps that edit under a backup ref and lands the host's", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true, mode: "from_cloud" });
  await h.jobs.pass();
  fs.writeFileSync(path.join(mirrorDir(), "a.txt"), "my laptop edit\n");
  fs.writeFileSync(path.join(h.host, "a.txt"), "host moved on\n");
  h.advance(5_000); await h.jobs.pass();
  expect(h.reports.at(-1)).toMatchObject({ status: "local_edit", files: ["a.txt"], mode: "from_cloud" });
  await h.jobs.handleCommand({ ...spec(), enable: true, overwrite: true });
  h.advance(5_000); await h.jobs.pass();
  expect(read(path.join(mirrorDir(), "a.txt"))).toBe("host moved on\n");
  const backup = git(mirrorDir(), "for-each-ref", "--format=%(refname)", "refs/codecast/backup/").split("\n")[0]!;
  expect(git(mirrorDir(), "show", `${backup}:a.txt`)).toBe("my laptop edit");
  await h.jobs.stop("conv1");
});

test("switching watch-only to two-way sends the edit that stopped it", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true, mode: "from_cloud" });
  await h.jobs.pass();
  fs.writeFileSync(path.join(mirrorDir(), "a.txt"), "keep me\n");
  h.advance(5_000); await h.jobs.pass();
  expect(h.reports.at(-1)!.status).toBe("local_edit");
  await h.jobs.handleCommand({ ...spec(), enable: true, mode: "two_way" });
  h.advance(5_000); await h.jobs.pass();
  expect(read(path.join(h.host, "a.txt"))).toBe("keep me\n");
  await h.jobs.stop("conv1");
});

test("a session that leaves the host ends its sync; jobs and their agreed state survive a restart", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true });
  await h.jobs.pass();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf-8"));
  expect(saved[0].spec).toEqual({ ...spec(), mode: "two_way" });
  expect(saved[0].state.base).toMatch(/^[0-9a-f]{40}$/);

  // Restarted: an edit made here while the daemon was down travels, and is not overwritten by the host's tree.
  fs.writeFileSync(path.join(mirrorDir(), "down.txt"), "made while stopped\n");
  const again = harness();
  await again.jobs.resumeAll();
  await again.jobs.pass();
  expect(read(path.join(again.host, "down.txt"))).toBe("made while stopped\n");

  again.activity.owner_device_id = "my-laptop";
  again.advance(MIRROR_ACTIVITY_POLL_MS); await again.jobs.pass();
  expect(again.reports.at(-1)).toEqual({ status: "off" });
  expect(JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf-8"))).toEqual([]);
});

test("an older daemon's job file, specs only, still resumes", async () => {
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify([spec()]));
  const h = harness();
  await h.jobs.resumeAll();
  await h.jobs.pass();
  expect(h.reports.map((r) => r.status)).toEqual(["starting", "live"]);
  await h.jobs.stop("conv1");
});
