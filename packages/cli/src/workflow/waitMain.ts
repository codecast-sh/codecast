// The change flow's Wait for main station (flows.md FL4): `cast flow
// wait-main` holds a change whose every CI failure also fails on the default
// branch until that branch's own CI is green again, then the run rebases the
// change onto it and runs CI once more. It reads the default branch's CI with
// `gh run list`, so it works for any repository on GitHub Actions.
import { defaultExec, type Exec } from "../lineMerge.js";

type Run = { databaseId: number; workflowName?: string; headSha: string; status: string; conclusion: string | null };

const PASSING = new Set(["success", "neutral", "skipped"]);
const short = (sha: string) => sha.slice(0, 10);

/** "1h 5m", "23m", "40s". */
export function spoken(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** The default branch's head and its CI there: green, red (with the failed runs), or still going. */
export function mainCi(exec: Exec, cwd: string, base: string): { head: string; state: "green" | "red" | "pending"; failed: Run[] } | { reason: string } {
  const ls = exec("git", ["ls-remote", "origin", `refs/heads/${base}`], cwd);
  const head = ls.stdout.trim().split(/\s/)[0] ?? "";
  if (!head) return { reason: `cannot read origin's ${base}: ${(ls.stderr || ls.stdout).trim().split("\n")[0] ?? ""}` };
  const list = exec("gh", ["run", "list", "--branch", base, "--limit", "50", "--json", "databaseId,workflowName,headSha,status,conclusion"], cwd);
  let runs: Run[];
  try { runs = (JSON.parse(list.stdout) as Run[]).filter((r) => r.headSha === head); } catch { return { reason: `gh run list failed: ${(list.stderr || list.stdout).trim().split("\n")[0] ?? ""}` }; }
  const failed = runs.filter((r) => r.status === "completed" && !PASSING.has(r.conclusion ?? ""));
  const state = failed.length ? "red" : runs.length && runs.every((r) => r.status === "completed") ? "green" : "pending";
  return { head, state, failed };
}

/** The failed jobs of the failed runs, as "<workflow>: <job>". */
function redJobs(exec: Exec, cwd: string, failed: Run[]): string[] {
  return failed.flatMap((r) => {
    const view = exec("gh", ["run", "view", String(r.databaseId), "--json", "jobs"], cwd);
    try {
      const jobs = (JSON.parse(view.stdout).jobs ?? []) as Array<{ name: string; conclusion: string | null }>;
      const bad = jobs.filter((j) => j.conclusion && !PASSING.has(j.conclusion)).map((j) => `${r.workflowName ?? "CI"}: ${j.name}`);
      return bad.length ? bad : [r.workflowName ?? `run ${r.databaseId}`];
    } catch {
      return [r.workflowName ?? `run ${r.databaseId}`];
    }
  });
}

export async function waitForMain(args: {
  cwd: string;
  base: string;
  deadlineMs: number;
  intervalMs: number;
  exec?: Exec;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  say?: (line: string) => void;
}): Promise<{ ok: boolean; line: string }> {
  const exec = args.exec ?? defaultExec;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let redSince = "";
  let last: ReturnType<typeof mainCi> | null = null;
  for (;;) {
    last = mainCi(exec, args.cwd, args.base);
    if ("state" in last && last.state === "green") return { ok: true, line: `Main CI is green at ${short(last.head)}.` };
    if ("state" in last && last.state === "red" && !redSince) redSince = last.head;
    const waited = now() - start;
    if (waited >= args.deadlineMs) break;
    args.say?.("reason" in last
      ? `Waiting for main CI to go green (${last.reason}; ${spoken(waited)} of ${spoken(args.deadlineMs)})`
      : `Waiting for main CI to go green (${redSince ? `red since ${short(redSince)}` : `running at ${short(last.head)}`}; ${spoken(waited)} of ${spoken(args.deadlineMs)})`);
    await sleep(args.intervalMs);
  }
  if ("reason" in last) return { ok: false, line: `Main CI never read green in ${spoken(args.deadlineMs)}: ${last.reason}.` };
  const jobs = last.failed.length ? redJobs(exec, args.cwd, last.failed) : [];
  return { ok: false, line: `Main CI stayed red for ${spoken(args.deadlineMs)}${redSince ? ` (red since ${short(redSince)})` : ""}, at ${short(last.head)}${jobs.length ? `: ${jobs.join(", ")}` : ", still running"}.` };
}
