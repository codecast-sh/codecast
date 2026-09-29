import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { remoteSnapshotScript } from "../wipSnapshot";
import { LiveSyncJobs, MIRROR_ACTIVE_WINDOW_MS, MIRROR_ACTIVITY_POLL_MS, type MirrorActivity, type MirrorReport } from "./liveSyncJobs";

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
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
  let snapshots = 0;
  const activity: MirrorActivity = { conversation_id: "conv1", message_count: 5, status: "active", owner_device_id: "host-dev" };
  const host = path.join(dir, "host");
  const jobs = new LiveSyncJobs({
    report: async (_id, r) => { reports.push(r); },
    activity: async () => [{ ...activity }],
    hostFor: () => ({ address: "h", user: "u", keyPath: "k", remoteBaseDir: "/w" } as any),
    log: () => {},
    jobsFile: path.join(dir, "jobs.json"),
    now: () => clock,
    tickDeps: (_spec, _h, local) => ({
      snapshot: async () => { snapshots++; return execFileSync("sh", ["-c", remoteSnapshotScript({ cwd: host, ref: "refs/codecast/sync/conv1" })], { encoding: "utf-8" }).trim().split("\n").pop()!; },
      fetch: async () => { git(local, "fetch", "-q", host, "+refs/codecast/sync/conv1:refs/codecast/sync/conv1"); },
    }),
  });
  return { jobs, reports, activity, host, advance: (ms: number) => { clock += ms; }, snapshots: () => snapshots };
}
const spec = () => ({ conversation_id: "conv1", host_device_id: "host-dev", remote_cwd: "/w/r", local_root: path.join(dir, "laptop") });

test("mirrors while the session works, pauses without touching the host when it idles, resumes when it works again", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true });
  const mirror = path.join(dir, "laptop/.codecast/worktrees/sync-conv1");
  fs.writeFileSync(path.join(h.host, "a.txt"), "host edit\n");
  await h.jobs.pass();
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("host edit\n");
  expect(h.reports.map((r) => r.status)).toEqual(["starting", "live"]);
  expect(h.reports[1]!.path).toBe(mirror);

  h.advance(MIRROR_ACTIVE_WINDOW_MS + MIRROR_ACTIVITY_POLL_MS);
  await h.jobs.pass();
  expect(h.reports.at(-1)!.status).toBe("paused");
  const polls = h.snapshots();
  h.advance(10_000); await h.jobs.pass();
  expect(h.snapshots()).toBe(polls);

  h.activity.message_count = 9;
  h.advance(MIRROR_ACTIVITY_POLL_MS);
  fs.writeFileSync(path.join(h.host, "b.txt"), "new\n");
  await h.jobs.pass();
  expect(fs.readFileSync(path.join(mirror, "b.txt"), "utf-8")).toBe("new\n");
  expect(h.reports.at(-1)).toMatchObject({ status: "live", changed: 1 });
  h.jobs.stop("conv1");
}, 30_000);

test("an edit made in the mirror stops it; overwrite keeps that edit under a backup ref and lands the host's", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true });
  const mirror = path.join(dir, "laptop/.codecast/worktrees/sync-conv1");
  await h.jobs.pass();
  fs.writeFileSync(path.join(mirror, "a.txt"), "my laptop edit\n");
  fs.writeFileSync(path.join(h.host, "a.txt"), "host moved on\n");
  h.advance(5_000); await h.jobs.pass();
  expect(h.reports.at(-1)).toMatchObject({ status: "local_edit", files: ["a.txt"] });
  await h.jobs.handleCommand({ ...spec(), enable: true, overwrite: true });
  h.advance(5_000); await h.jobs.pass();
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("host moved on\n");
  const backup = git(mirror, "for-each-ref", "--format=%(refname)", "refs/codecast/backup/").split("\n")[0]!;
  expect(git(mirror, "show", `${backup}:a.txt`)).toBe("my laptop edit");
  h.jobs.stop("conv1");
}, 30_000);

test("a session that leaves the host ends its mirror; jobs survive a restart", async () => {
  const h = harness();
  await h.jobs.handleCommand({ ...spec(), enable: true });
  expect(JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf-8"))).toEqual([spec()]);
  const again = harness();
  await again.jobs.resumeAll();
  expect(again.reports[0]).toMatchObject({ status: "starting" });
  again.activity.owner_device_id = "my-laptop";
  again.advance(MIRROR_ACTIVITY_POLL_MS); await again.jobs.pass();
  expect(again.reports.at(-1)).toEqual({ status: "off" });
  expect(JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf-8"))).toEqual([]);
  h.jobs.stop("conv1");
}, 30_000);
