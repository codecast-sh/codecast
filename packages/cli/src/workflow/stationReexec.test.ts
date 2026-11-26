// A parked station moves onto a newer installed CLI between polls (stationReexec.ts), keeping its place. The
// end-to-end case runs the CI station as two fake CLI entrypoints, version N and N+1: N reruns the failed jobs,
// `cast update` renames N+1 over it while it is parked, and N+1 must carry on from there (same deadline, no second
// rerun) and be the one that writes the verdict.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { RESUME_ENV, stationCli } from "./stationReexec";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-station-reexec-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const exit = (code: number): never => { throw new Exited(code); };
const neverRun = () => { throw new Error("ran a newer CLI"); };

describe("stationCli", () => {
  test("a run from source never swaps, whatever the installed binary does", async () => {
    // Under bun the entry is a script, not the compiled cast: there is no binary to watch.
    await stationCli({ command: neverRun, exit, env: {} }).between({ at: 1 });
  });

  test("the same installed binary keeps the station where it is; a binary renamed over it runs the command with its place", async () => {
    const bin = path.join(tmp, "cast-unit");
    fs.writeFileSync(bin, "v1");
    const ran: string[][] = [];
    const cli = stationCli({
      binary: bin,
      args: ["flow", "ci", "--pr", "7"],
      command: (a) => { ran.push(a); return { executablePath: process.execPath, args: ["-e", `process.exit(process.env.${RESUME_ENV} === JSON.stringify({ args: ${JSON.stringify(["flow", "ci", "--pr", "7"])}, place: { at: 2 } }) ? 3 : 9)`] }; },
      exit,
      env: { ...process.env },
    });
    await cli.between({ at: 1 });
    expect(ran).toEqual([]);
    fs.writeFileSync(`${bin}.next`, "v2");
    fs.renameSync(`${bin}.next`, bin);
    const err = await cli.between({ at: 2 }).catch((e) => e);
    expect(ran).toEqual([["flow", "ci", "--pr", "7"]]);
    // The newer run's own code: 3 says it was handed exactly this command and place.
    expect(err).toBeInstanceOf(Exited);
    expect((err as Exited).code).toBe(3);
  });

  test("a place is taken only by the command that handed it, and off the environment, so nothing the station starts sees it", () => {
    const env: NodeJS.ProcessEnv = { [RESUME_ENV]: JSON.stringify({ args: ["flow", "ci"], place: { started: 5 } }) };
    expect(stationCli({ args: ["flow", "ci"], env }).resumed<{ started: number }>()).toEqual({ started: 5 });
    expect(env[RESUME_ENV]).toBeUndefined();
    expect(stationCli({ args: ["flow", "ci"], env }).resumed()).toBeNull();
    expect(stationCli({ args: ["flow", "wait-main"], env: { [RESUME_ENV]: JSON.stringify({ args: ["flow", "ci"], place: { started: 5 } }) } }).resumed()).toBeNull();
    expect(stationCli({ args: ["flow", "ci"], env: { [RESUME_ENV]: "{not json" } }).resumed()).toBeNull();
  });
});

const SRC = path.resolve(import.meta.dir, "..");

/** A fake installed `cast` at one version: the CI station over a GitHub kept in a file, so both versions see one GitHub. */
const entry = (version: string) => `
import * as fs from "node:fs";
import * as path from "node:path";
import { runCiStation } from ${JSON.stringify(path.join(SRC, "workflow/ciStation.ts"))};
import { RESUME_ENV, stationCli } from ${JSON.stringify(path.join(SRC, "workflow/stationReexec.ts"))};
import { BUN_LOG } from ${JSON.stringify(path.join(SRC, "workflow/ciStation.testkit.ts"))};
const VERSION = ${JSON.stringify(version)};
const self = process.argv[1]!;
const dir = process.argv[2]!;
fs.appendFileSync(path.join(dir, "starts.jsonl"), JSON.stringify({ version: VERSION, handed: process.env[RESUME_ENV] ?? null, at: Date.now() }) + "\\n");
const github = path.join(dir, "github.json");
const gh = (args: string[]) => {
  const a = args.join(" ");
  fs.appendFileSync(path.join(dir, "gh.log"), VERSION + " " + a + "\\n");
  const { attempt } = JSON.parse(fs.readFileSync(github, "utf-8"));
  if (a.startsWith("pr view")) return { code: 0, out: JSON.stringify({ url: "https://github.com/acme/app/pull/7", headRefOid: "a".repeat(40), headRefName: "feature", baseRefName: "main", baseRefOid: "f".repeat(40), mergeable: "MERGEABLE", statusCheckRollup: [{ __typename: "CheckRun", name: "test-cli", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/app/actions/runs/900/job/21", startedAt: "2026-11-20T16:00:00Z", completedAt: "2026-11-20T16:03:00Z" }] }) };
  if (a.startsWith("run list --repo acme/app --commit " + "a".repeat(40))) return { code: 0, out: JSON.stringify([{ databaseId: 900, status: "completed", conclusion: "failure", attempt, workflowName: "CI", event: "pull_request" }]) };
  if (a.startsWith("api --paginate repos/acme/app/pulls/7/files")) return { code: 0, out: "src/app.ts" };
  if (a.startsWith("api --paginate repos/acme/app/actions/workflows")) return { code: 0, out: "" };
  if (a.startsWith("run rerun 900")) { fs.writeFileSync(github, JSON.stringify({ attempt: attempt + 1 })); return { code: 0, out: "" }; }
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
const cli = stationCli({ binary: self, command: (a) => ({ executablePath: process.execPath, args: [self, ...a] }) });
const { result, summary } = await runCiStation({ pr: 7, dir, deadlineMs: 600_000, gh, sleep, pollMs: 5, cli });
console.log(JSON.stringify({ version: VERSION, summary, reran: result.reran }));
`;

describe("a parked CI station across cast update", () => {
  test("started on N, it resumes on N+1 without losing its place: one rerun, its deadline kept, N+1's verdict", () => {
    const dir = path.join(tmp, "run");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "github.json"), JSON.stringify({ attempt: 1 }));
    const installed = path.join(dir, "cast.ts");
    fs.writeFileSync(installed, entry("1.1.263"));
    fs.writeFileSync(path.join(dir, "cast.next.ts"), entry("1.1.265"));
    const before = Date.now();

    const { [RESUME_ENV]: _, ...env } = process.env;
    const r = spawnSync(process.execPath, [installed, dir], { encoding: "utf-8", timeout: 60_000, env });
    expect(r.stderr).not.toContain("error:");
    expect(r.status).toBe(0);

    // One start on each version: N+1 does not swap again (its own binary is the installed one).
    const starts = fs.readFileSync(path.join(dir, "starts.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(starts.map((s) => s.version)).toEqual(["1.1.263", "1.1.265"]);
    expect(starts[0].handed).toBeNull();
    const handed = JSON.parse(starts[1].handed);
    expect(handed.args).toEqual([dir]);
    expect(handed.place).toMatchObject({ reran: true, reruns: [[900, 1]], seen: "a".repeat(40) });
    // The deadline runs from N's start, not from N+1's.
    expect(handed.place.started).toBeGreaterThanOrEqual(before);
    expect(handed.place.started).toBeLessThanOrEqual(starts[1].at);

    // N reran the failed jobs once; N+1 saw the rerun's attempt finish red and judged it, rerunning nothing.
    const calls = fs.readFileSync(path.join(dir, "gh.log"), "utf-8").trim().split("\n");
    expect(calls.filter((c) => c.includes("run rerun"))).toEqual(["1.1.263 run rerun 900 --failed --repo acme/app"]);
    expect(calls.some((c) => c.startsWith("1.1.265 run view 900"))).toBe(true);

    // Only N+1 spoke: its verdict is the station's output and its ci.json the one on disk.
    const out = r.stdout.trim().split("\n");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ version: "1.1.265", reran: true, summary: expect.stringContaining("CI red on #7") });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8"))).toMatchObject({ reran: true, green: false, head_sha: "a".repeat(40) });
  });
});
