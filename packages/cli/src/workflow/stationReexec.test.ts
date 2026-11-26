// A parked station moves onto a newer installed CLI between polls (stationReexec.ts), keeping its place. The
// end-to-end cases run the CI station as fake installed `cast` entrypoints over one GitHub kept in a file: version N
// reruns the failed jobs, `cast update` renames another file over it while it is parked, and either N+1 carries on
// from there (same deadline, no second rerun), or a binary that cannot take over leaves N where it was.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { MAX_HOPS, RESUME_ENV, stationCli } from "./stationReexec";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-station-reexec-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const exit = (code: number): never => { throw new Exited(code); };
const neverRun = () => { throw new Error("ran the installed CLI"); };
const SRC = path.resolve(import.meta.dir, "..");
const REEXEC = JSON.stringify(path.join(SRC, "workflow/stationReexec.ts"));
const swap = (file: string, text: string) => { fs.writeFileSync(`${file}.next`, text, { mode: 0o755 }); fs.renameSync(`${file}.next`, file); };

describe("stationCli", () => {
  test("a run from source never swaps, whatever the installed binary does", async () => {
    // Under bun the entry is a script, not the compiled cast: there is no binary to watch.
    await stationCli({ command: neverRun, exit, env: {} }).between({ at: 1 });
  });

  test("a place is taken only by the direct child it was handed to, running the same command, which acknowledges it", () => {
    const ack = path.join(tmp, "unit.ack");
    const handed = (o: Partial<{ args: string[]; parent: number }> = {}) => ({ [RESUME_ENV]: JSON.stringify({ args: ["flow", "ci"], parent: 41, ack, hops: 1, place: { started: 5 }, ...o }) });
    const env: NodeJS.ProcessEnv = handed();
    expect(stationCli({ args: ["flow", "ci"], ppid: 41, env }).resumed<{ started: number }>()).toEqual({ started: 5 });
    expect(fs.existsSync(ack)).toBe(true);
    expect(env[RESUME_ENV]).toBeUndefined();
    fs.rmSync(ack);
    // A grandchild (gh, a `cast` the station runs) inherits the variable under Bun, but its parent is not the one named.
    expect(stationCli({ args: ["flow", "ci"], ppid: 42, env: handed() }).resumed()).toBeNull();
    expect(stationCli({ args: ["flow", "wait-main"], ppid: 41, env: handed() }).resumed()).toBeNull();
    expect(stationCli({ args: ["flow", "ci"], ppid: 41, env: { [RESUME_ENV]: "{not json" } }).resumed()).toBeNull();
    expect(fs.existsSync(ack)).toBe(false);
  });

  test("a station that already hopped MAX_HOPS times stays where it is", async () => {
    const bin = path.join(tmp, "cast-hops");
    fs.writeFileSync(bin, "v1");
    const env = { [RESUME_ENV]: JSON.stringify({ args: ["x"], parent: 41, ack: path.join(tmp, "hops.ack"), hops: MAX_HOPS, place: {} }) };
    const cli = stationCli({ binary: bin, args: ["x"], ppid: 41, env, version: "1.0.0", command: neverRun, exit });
    swap(bin, "v2");
    await cli.between({});
  });

  // An npm install keeps the compiled binary under node_modules (codecast/vendor/codecast). The newer one is run as
  // itself with the verb and flags as given: no `--` (after which commander reads flags as operands) and no entry script.
  test("the compiled binary is run as itself, verbs and flags as given, even under node_modules", async () => {
    const bin = path.join(tmp, "node_modules/codecast/vendor/codecast");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const script = (version: string) => `#!${process.execPath}
import * as fs from "node:fs";
import { stationCli } from ${REEXEC};
if (process.argv[2] === "--version") { console.log("codecast ${version}"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(path.join(tmp, "npm-argv.json"))}, JSON.stringify(process.argv.slice(2)));
stationCli({ binary: null, args: process.argv.slice(2) });
process.exit(7);
`;
    fs.writeFileSync(bin, script("1.1.263"), { mode: 0o755 });
    const cli = stationCli({ binary: bin, args: ["flow", "ci", "--pr", "7"], version: "1.1.263", exit, env: { ...process.env } });
    await cli.between({});
    swap(bin, script("1.1.265"));
    const err = await cli.between({ at: 2 }).catch((e) => e);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "npm-argv.json"), "utf-8"))).toEqual(["flow", "ci", "--pr", "7"]);
    // It acknowledged, so its code is the station's: 7, a signal 128 + its number.
    expect(err).toBeInstanceOf(Exited);
    expect((err as Exited).code).toBe(7);
  });
});

/** A fake installed `cast` at one version: the CI station over a GitHub kept in a file, so every version sees one GitHub. */
const station = (version: string) => `
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runCiStation } from ${JSON.stringify(path.join(SRC, "workflow/ciStation.ts"))};
import { RESUME_ENV, stationCli } from ${REEXEC};
import { BUN_LOG } from ${JSON.stringify(path.join(SRC, "workflow/ciStation.testkit.ts"))};
const VERSION = ${JSON.stringify(version)};
const self = process.argv[1]!;
if (process.argv[2] === "--version") { console.log(VERSION); process.exit(0); }
const dir = process.argv[2]!;
const log = (file: string, line: unknown) => fs.appendFileSync(path.join(dir, file), JSON.stringify(line) + "\\n");
log("starts.jsonl", { version: VERSION, handed: process.env[RESUME_ENV] ?? null, at: Date.now() });
const github = path.join(dir, "github.json");
let probed = false;
const gh = (args: string[]) => {
  const a = args.join(" ");
  fs.appendFileSync(path.join(dir, "gh.log"), VERSION + " " + a + "\\n");
  // What the station starts inherits the environment it began with (Bun): a \`cast\` run there must not take the place.
  if (!probed) { probed = true; spawnSync(process.execPath, [path.join(dir, "probe.ts"), dir, VERSION], { stdio: "ignore" }); }
  const gitHub = JSON.parse(fs.readFileSync(github, "utf-8"));
  if (a.startsWith("pr view")) return { code: 0, out: JSON.stringify({ url: "https://github.com/acme/app/pull/7", headRefOid: "a".repeat(40), headRefName: "feature", baseRefName: "main", baseRefOid: "f".repeat(40), mergeable: "MERGEABLE", statusCheckRollup: [{ __typename: "CheckRun", name: "test-cli", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/app/actions/runs/900/job/21", startedAt: "2026-11-20T16:00:00Z", completedAt: "2026-11-20T16:03:00Z" }] }) };
  if (a.startsWith("run list --repo acme/app --commit " + "a".repeat(40))) {
    const going = gitHub.pending > 0;
    if (going) fs.writeFileSync(github, JSON.stringify({ ...gitHub, pending: gitHub.pending - 1 }));
    return { code: 0, out: JSON.stringify([{ databaseId: 900, status: going ? "in_progress" : "completed", conclusion: going ? "" : "failure", attempt: gitHub.attempt, workflowName: "CI", event: "pull_request" }]) };
  }
  if (a.startsWith("api --paginate repos/acme/app/pulls/7/files")) return { code: 0, out: "src/app.ts" };
  if (a.startsWith("api --paginate repos/acme/app/actions/workflows")) return { code: 0, out: "" };
  if (a.startsWith("run rerun 900")) { fs.writeFileSync(github, JSON.stringify({ ...gitHub, attempt: gitHub.attempt + 1, pending: gitHub.pendingAfterRerun })); return { code: 0, out: "" }; }
  if (a.startsWith("run view 900")) return { code: 0, out: JSON.stringify({ jobs: [{ name: "test-cli", databaseId: 21, status: "completed", conclusion: "failure" }] }) };
  if (a.startsWith("api repos/acme/app/actions/jobs/21/logs")) return { code: 0, out: BUN_LOG };
  if (a.startsWith("run list")) return { code: 0, out: "[]" };
  return { code: 1, out: "HTTP 404" };
};
// While the station is parked, \`cast update\` renames the next binary over this one.
const sleep = async (ms: number) => {
  const next = path.join(dir, "cast.next.ts");
  if (fs.existsSync(next)) fs.renameSync(next, self);
  await new Promise((r) => setTimeout(r, ms));
};
const cli = stationCli({ binary: self, version: VERSION, command: (a) => ({ executablePath: process.execPath, args: [self, ...a] }) });
const { result, summary } = await runCiStation({ pr: 7, dir, deadlineMs: 600_000, gh, sleep, pollMs: 5, cli });
console.log(JSON.stringify({ version: VERSION, summary, reran: result.reran }));
`;

/** What a `cast` the station starts sees: the inherited variable, and whether it would take the place. */
const probe = `
import * as fs from "node:fs";
import * as path from "node:path";
import { RESUME_ENV, stationCli } from ${REEXEC};
const [dir, version] = process.argv.slice(2);
const inherited = !!process.env[RESUME_ENV];
fs.appendFileSync(path.join(dir!, "probe.jsonl"), JSON.stringify({ version, inherited, took: stationCli({ args: [dir!], binary: null }).resumed() !== null }) + "\\n");
`;

/** A newer binary that cannot take a station over: it says its version, and dies on anything else. */
const broken = (dir: string) => `
import * as fs from "node:fs";
if (process.argv[2] === "--version") { console.log("1.1.265"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(dir, "broken.log"))}, process.argv.slice(2).join(" ") + "\\n");
console.error("error: unknown option '--dir'");
process.exit(1);
`;

function runStation(name: string, next: string, github: { pendingAfterRerun: number }) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "github.json"), JSON.stringify({ attempt: 1, pending: 0, ...github }));
  fs.writeFileSync(path.join(dir, "probe.ts"), probe);
  const installed = path.join(dir, "cast.ts");
  fs.writeFileSync(installed, station("1.1.263"));
  fs.writeFileSync(path.join(dir, "cast.next.ts"), next);
  const { [RESUME_ENV]: _, ...env } = process.env;
  const before = Date.now();
  const r = spawnSync(process.execPath, [installed, dir], { encoding: "utf-8", timeout: 60_000, env });
  const lines = (file: string) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), "utf-8").trim().split("\n") : []);
  return {
    r,
    dir,
    before,
    starts: lines("starts.jsonl").map((l) => JSON.parse(l)),
    calls: lines("gh.log"),
    probes: lines("probe.jsonl").map((l) => JSON.parse(l)),
    out: r.stdout.trim().split("\n"),
    lines,
  };
}

describe("a parked CI station across cast update", () => {
  test("started on N, it resumes on N+1 without losing its place: one rerun, its deadline kept, N+1's verdict", () => {
    const { r, dir, before, starts, calls, probes, out } = runStation("resumes", station("1.1.265"), { pendingAfterRerun: 0 });
    expect(r.stderr).not.toContain("error:");
    expect(r.status).toBe(0);

    // One start on each version: N+1 does not swap again (its own binary is the installed one).
    expect(starts.map((s) => s.version)).toEqual(["1.1.263", "1.1.265"]);
    expect(starts[0].handed).toBeNull();
    const handed = JSON.parse(starts[1].handed);
    expect(handed).toMatchObject({ args: [dir], hops: 1 });
    expect(handed.place).toMatchObject({ reran: true, reruns: [[900, 1]], seen: "a".repeat(40), settled: false });
    // The deadline runs from N's start, not from N+1's.
    expect(handed.place.started).toBeGreaterThanOrEqual(before);
    expect(handed.place.started).toBeLessThanOrEqual(starts[1].at);

    // N reran the failed jobs once; N+1 saw the rerun's attempt finish red and judged it, rerunning nothing.
    expect(calls.filter((c) => c.includes("run rerun"))).toEqual(["1.1.263 run rerun 900 --failed --repo acme/app"]);
    expect(calls.some((c) => c.startsWith("1.1.265 run view 900"))).toBe(true);

    // What N+1 starts inherits the variable (Bun passes the environment it began with), and never takes the place.
    expect(probes).toEqual([{ version: "1.1.263", inherited: false, took: false }, { version: "1.1.265", inherited: true, took: false }]);

    // Only N+1 spoke: its verdict is the station's output and its ci.json the one on disk.
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ version: "1.1.265", reran: true, summary: expect.stringContaining("CI red on #7") });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8"))).toMatchObject({ reran: true, green: false, head_sha: "a".repeat(40) });
  });

  test("a newer binary that dies before resuming leaves N polling, and is never tried again", () => {
    // The rerun runs for three more looks, so N polls past the failed takeover several times.
    const { r, dir, starts, calls, out, lines } = runStation("broken", broken(path.join(tmp, "broken")), { pendingAfterRerun: 3 });
    expect(r.status).toBe(0);
    expect(starts.map((s) => s.version)).toEqual(["1.1.263"]);
    expect(lines("broken.log")).toEqual([dir]);
    expect(r.stderr).toContain("cast 1.1.265 did not take this station over (it exited 1 before resuming); staying on 1.1.263");
    expect(calls.filter((c) => c.includes("run rerun"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("1.1.263 run list --repo acme/app --commit")).length).toBeGreaterThanOrEqual(4);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ version: "1.1.263", reran: true, summary: expect.stringContaining("CI red on #7") });
  });

  test("an older or equal version is never taken, so a rollback leaves the station where it is", () => {
    const { r, starts, out } = runStation("rollback", station("1.1.200"), { pendingAfterRerun: 2 });
    expect(r.status).toBe(0);
    expect(starts.map((s) => s.version)).toEqual(["1.1.263"]);
    expect(JSON.parse(out[0]!)).toMatchObject({ version: "1.1.263", reran: true });
  });
});
