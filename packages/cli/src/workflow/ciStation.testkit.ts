// The CI station's test fixtures: job logs recorded from GitHub, trimmed, how a test reads failures, and a fake gh.
import type { Gh } from "./ciStation.js";

// Recorded from a codecast test-cli job log (GitHub's job-logs API), trimmed.
export const BUN_LOG = `2026-11-20T16:32:42.5694615Z ##[group]src/bench/bootGraph.guard.test.ts:
2026-11-20T16:32:42.5695355Z (pass) command groups stay off the boot graph > every listed group resolves to a module that exists [0.39ms]
2026-11-20T16:32:42.5698230Z
2026-11-20T16:32:42.5698612Z ##[endgroup]
2026-11-20T16:32:42.5701591Z ##[group]src/bench/bootGraph.guard.test.ts:
2026-11-20T16:32:42.5706082Z 721 |     // 616 on 2026-11-20: subagentFinish.ts (node imports only), which marks a finished
2026-11-20T16:32:42.5707929Z 723 |     expect(graph.nodes.size, "source files on daemon.ts's static graph").toBeLessThanOrEqual(616);
2026-11-20T16:32:42.5709170Z                                                                                ^
2026-11-20T16:32:42.5710118Z error: source files on daemon.ts's static graph
2026-11-20T16:32:42.5710353Z
2026-11-20T16:32:42.5710448Z Expected: <= 616
2026-11-20T16:32:42.5710656Z Received: 617
2026-11-20T16:32:42.5710777Z
2026-11-20T16:32:42.5711319Z       at <anonymous> (/home/runner/work/app/app/packages/cli/src/bench/bootGraph.guard.test.ts:723:74)
2026-11-20T16:32:42.5711774Z
2026-11-20T16:32:42.5735606Z ##[error]Expected: <= 616
Received: 617

      at <anonymous> (/home/runner/work/app/app/packages/cli/src/bench/bootGraph.guard.test.ts:723:74)
2026-11-20T16:32:42.5746042Z (fail) command groups stay off the boot graph > the daemon carries no CLI command group either [120.84ms]
2026-11-20T16:32:42.5747242Z (pass) command groups stay off the boot graph > commandGroups.ts is a leaf: it imports no repo module at runtime [0.39ms]
2026-11-20T16:38:42.3064716Z 1 tests failed:
2026-11-20T16:38:42.3065139Z (fail) command groups stay off the boot graph > the daemon carries no CLI command group either [120.84ms]
2026-11-20T16:38:42.3066419Z  1 fail
2026-11-20T16:38:42.6071615Z ##[error]Process completed with exit code 1.
2026-11-20T16:38:42.7000000Z Cleaning up orphan processes`;
export const BUN_TEST = "command groups stay off the boot graph > the daemon carries no CLI command group either";
export const OTHER_TEST_LOG = BUN_LOG.replace(/the daemon carries no CLI command group either/g, "a test main breaks");
export const STEP_END = (code = 1) => `2026-11-20T16:38:42.6071615Z ##[error]Process completed with exit code ${code}.`;
export const bunLogBody = BUN_LOG.split("\n").filter((l) => !/Process completed|orphan/.test(l)).join("\n");
export const VITE_LOG = (msg: string, exit = 1) => `2026-11-20T16:40:00.0Z vite v5.4.0 building for production...
2026-11-20T16:40:01.0Z error during build: ${msg}
2026-11-20T16:40:02.0Z ##[error]Process completed with exit code ${exit}.
2026-11-20T16:40:03.0Z Terminate orphan process: pid (3112) (tmux: server)`;
export const mergeLog = (head: string, main: string) => `2026-11-20T16:31:59.6165267Z HEAD is now at 5b5bb47 Merge ${head} into ${main}\n`;
export const tests = (fs_: Array<{ job: string; test: string | null }>) => fs_.map((f) => [f.job, f.test]);

export const REPO = "acme/app";
export const HEAD = "a".repeat(40);
export const NEW_HEAD = "e".repeat(40);
export const MAIN = "b".repeat(40);
export const OLDER_MAIN = "c".repeat(40);
export const BASE_OID = "f".repeat(40);
export const NOW = Date.parse("2026-11-21T00:00:00Z");

export type Rollup = Record<string, any>;
const T0 = Date.parse("2026-11-20T16:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
export const check = (name: string, conclusion: string | null, job: number, mins = 3, startMin = 0, run = 900): Rollup => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  conclusion: conclusion ?? "",
  detailsUrl: `https://github.com/${REPO}/actions/runs/${run}/job/${job}`,
  startedAt: at(startMin),
  completedAt: conclusion ? at(startMin + mins) : null,
});
// GitHub's shape for a skipped job: it completes before it starts.
export const skippedCheck = (name: string, job: number): Rollup => ({ ...check(name, "SKIPPED", job), startedAt: at(5), completedAt: at(4) });
export const status = (context: string, state: string): Rollup => ({ __typename: "StatusContext", context, state, targetUrl: `https://ci.example/${context}` });
export const job = (name: string, id: number, conclusion: string) => ({ name, databaseId: id, status: "completed", conclusion });
const workflowFile = (text: string) => Buffer.from(text).toString("base64");
export const CI_WORKFLOW = "name: CI\non:\n  pull_request:\n";

interface Poll { rollup: Rollup[]; head?: string; runs?: Array<Record<string, any>>; mergeable?: string }

/**
 * A fake gh. Each poll of the pull request answers with the next entry of `polls` (the last repeats). The head's
 * workflow run defaults to run 900, whose jobs are its checks: in progress until they are done, then a success
 * when all passed, its attempt counting reruns. Main's runs answer by the sha asked for (`mainAt`), or as the
 * runs before a date (`mainEarlier`).
 */
export function fakeGh(o: {
  polls: Poll[];
  logs?: Record<number, string>;
  mainAt?: Record<string, Array<Record<string, any>>>;
  mainEarlier?: Array<Record<string, any>>;
  /** Main's runs created at or after a date, newest first, as `gh run list --created >=` lists them. */
  mainLater?: Array<Record<string, any>>;
  /** What the pull request's files query prints when it asks for each file's blob: `<sha> <status> <path>` lines. */
  fileShas?: string[];
  jobs?: Record<number, any[]>;
  workflows?: Record<string, string>;
  /** Other repository files by path, as GitHub's contents API serves them (the base's .codecast/line.toml). */
  repoFiles?: Record<string, string>;
  /** GitHub's compare status by `base...head` (ahead, behind, diverged); absent, the compare fails as for an unknown sha. */
  compare?: Record<string, string>;
  /** What the pull request's files query prints: each path, and a renamed file's old path. */
  files?: string[];
  fail?: (a: string) => { code: number; out: string } | null;
  onLog?: (jobId: number) => void;
  /** How gh treats --allow-escape-sequences on a log read: 2.105 refuses a log without it, a gh older than the flag rejects it. */
  escapes?: "required" | "unknown";
}): Gh & { calls: string[] } {
  let poll = -1;
  let attempt = 1;
  // GitHub shows a rerun run as going again until its new attempt's jobs land.
  let rerunOf: string | null = null;
  const calls: string[] = [];
  const current = () => o.polls[Math.max(0, Math.min(poll, o.polls.length - 1))]!;
  const gh = ((args: string[]) => {
    const a = args.join(" ");
    calls.push(a);
    const failed = o.fail?.(a);
    if (failed) return failed;
    if (a.startsWith("pr view")) {
      poll++;
      const p = current();
      return { code: 0, out: JSON.stringify({ url: `https://github.com/${REPO}/pull/7`, headRefOid: p.head ?? HEAD, headRefName: "feature", baseRefName: "main", baseRefOid: BASE_OID, mergeable: p.mergeable ?? "MERGEABLE", statusCheckRollup: p.rollup }) };
    }
    if (a.startsWith(`api --paginate repos/${REPO}/pulls/7/files`) && a.includes(".sha")) return { code: 0, out: (o.fileShas ?? []).join("\n") };
    if (a.startsWith(`api --paginate repos/${REPO}/pulls/7/files`)) return { code: 0, out: (o.files ?? ["src/app.ts"]).join("\n") };
    const compare = /^api repos\/acme\/app\/compare\/(\S+) --jq \.status$/.exec(a);
    if (compare) return o.compare?.[compare[1]!] ? { code: 0, out: o.compare[compare[1]!]! } : { code: 1, out: "HTTP 404: No common ancestor or unknown sha" };
    const commit = /^run list .*--commit (\S+)/.exec(a);
    if (commit && commit[1] === (current().head ?? HEAD)) {
      const p = current();
      const actions = p.rollup.filter((c) => c.__typename === "CheckRun" && /\/actions\/runs\//.test(c.detailsUrl));
      const done = actions.every((c) => c.status === "COMPLETED") && JSON.stringify(p.rollup) !== rerunOf;
      const passed = actions.every((c) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion));
      const runs = p.runs ?? (actions.length ? [{ databaseId: 900, status: done ? "completed" : "in_progress", conclusion: done ? (passed ? "success" : "failure") : "", attempt, workflowName: "CI", event: "pull_request" }] : []);
      return { code: 0, out: JSON.stringify(runs) };
    }
    if (commit) return { code: 0, out: JSON.stringify(o.mainAt?.[commit[1]!] ?? []) };
    if (a.startsWith("run list") && a.includes("--created >=")) return { code: 0, out: JSON.stringify(o.mainLater ?? []) };
    if (a.startsWith("run list") && a.includes("--created")) return { code: 0, out: JSON.stringify(o.mainEarlier ?? []) };
    if (a.startsWith("run rerun")) { attempt++; rerunOf = JSON.stringify(current().rollup); return { code: 0, out: "" }; }
    const log = /^api repos\/acme\/app\/actions\/jobs\/(\d+)\/logs( --allow-escape-sequences)?$/.exec(a);
    if (log) {
      if (o.escapes === "required" && !log[2]) return { code: 1, out: "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" };
      if (o.escapes === "unknown" && log[2]) return { code: 1, out: "unknown flag: --allow-escape-sequences\n\nUsage:  gh api <endpoint> [flags]" };
      o.onLog?.(Number(log[1]));
      return o.logs?.[Number(log[1])] !== undefined ? { code: 0, out: o.logs[Number(log[1])]! } : { code: 1, out: "HTTP 404: BlobNotFound" };
    }
    const view = /^run view (\d+) .*--json jobs$/.exec(a);
    if (view) {
      const id = Number(view[1]);
      const own = current().rollup.filter((c) => c.__typename === "CheckRun" && String(c.detailsUrl).includes(`/runs/${id}/job/`));
      const derived = own.map((c) => job(c.name, Number(/job\/(\d+)/.exec(c.detailsUrl)![1]), String(c.conclusion).toLowerCase()));
      return { code: 0, out: JSON.stringify({ jobs: o.jobs?.[id] ?? derived }) };
    }
    const workflows = o.workflows ?? { ".github/workflows/ci.yml": CI_WORKFLOW };
    if (a.startsWith(`api --paginate repos/${REPO}/actions/workflows`)) return { code: 0, out: Object.keys(workflows).join("\n") };
    const file = /^api repos\/acme\/app\/contents\/(\S+)\?ref=/.exec(a);
    if (file && o.repoFiles?.[file[1]!] !== undefined) return { code: 0, out: workflowFile(o.repoFiles[file[1]!]!) };
    if (file) return workflows[file[1]!] !== undefined ? { code: 0, out: workflowFile(workflows[file[1]!]!) } : { code: 1, out: "HTTP 404: Not Found" };
    return { code: 1, out: `unexpected gh ${a}` };
  }) as Gh & { calls: string[] };
  gh.calls = calls;
  return gh;
}
