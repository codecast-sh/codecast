// A test file that fails in a run of many and passes when run again alone failed from this machine's load, not
// from the change: under load averages of 35 to 50, web's replayPlayer.mount and replyStreamConversation.mount,
// calls.degrade and cli's workers and subprocess tests went red and passed alone (ct-102063). CI's runners carry
// no such load, so local.ts runs each failing file once more, alone, and reports the ones that pass as flaky
// under load rather than red. A file that fails only beside others (state one file leaks into the next) passes
// alone too: CI, which runs it beside others, still catches that, at the cost of the round this would have saved.
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CiFailure } from "../../packages/shared/contracts/ciFailures";
import type { JobResult } from "./local";

/** More failing files than this is the change, not the load: they all stay red, and nothing runs again. */
export const MAX_RERUNS = 5;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Jobs whose failures no test run cures: a lint or type error in a test file is still there when the file passes. */
const NOT_TESTS = new Set(["lint", "typecheck", "ci-station"]);
/** How a file's run alone ended: it passed, it failed, or it was stopped (a timeout, the budget) before a verdict. */
export type Alone = "pass" | "fail" | "stopped";

/** The directory a test file's suite runs from (its nearest package.json), and the file's path from there. */
export function suiteOf(root: string, file: string): { dir: string; rel: string } {
  let dir = dirname(join(root, file));
  while (dir.startsWith(root) && dir !== root && !existsSync(join(dir, "package.json"))) dir = dirname(dir);
  return { dir, rel: relative(dir, join(root, file)) };
}

/**
 * The failures split into those still failing, those whose test file passed alone (flaky), and those whose run
 * alone was stopped before a verdict (unjudged: neither red nor green). `runAlone` runs one file by itself; it is
 * never called for more than MAX_RERUNS files, or once `canRerun` says the run has no time left.
 */
export async function sortFlaky(failing: CiFailure[], runAlone: (file: string) => Promise<Alone>, canRerun: () => boolean = () => true): Promise<{ failing: CiFailure[]; flaky: CiFailure[]; unjudged: CiFailure[] }> {
  const ranAgain = (f: CiFailure): f is CiFailure & { file: string } => !NOT_TESTS.has(f.job) && !!f.file && TEST_FILE.test(f.file);
  const files = [...new Set(failing.filter(ranAgain).map((f) => f.file))];
  const alone = new Map<string, Alone>();
  if (files.length <= MAX_RERUNS) {
    for (const file of files) {
      if (!canRerun()) break;
      alone.set(file, await runAlone(file));
    }
  }
  const ended = (f: CiFailure, how: Alone) => ranAgain(f) && alone.get(f.file) === how;
  return {
    failing: failing.filter((f) => !ended(f, "pass") && !ended(f, "stopped")),
    flaky: failing.filter((f) => ended(f, "pass")),
    unjudged: failing.filter((f) => ended(f, "stopped")).map((f) => ({ ...f, assertion: `failed in the run; run again alone, it was stopped before a verdict. ${f.assertion ?? ""}`.trim() })),
  };
}

/**
 * Each job that ran red, as the reruns alone left it: failing while any failure of its stays, else no verdict while a
 * rerun was stopped, else passing, and its counts those that are left (still failing, flaky, not judged), never the
 * count it ran with ("pass 30s 1 failing" for a job whose one failure passed alone).
 */
export function settledJobs(results: JobResult[], left: { failing: CiFailure[]; flaky: CiFailure[]; unjudged: CiFailure[] }): JobResult[] {
  return results.map((r) => {
    if (r.status !== "fail") return r;
    const of = (list: CiFailure[]) => list.filter((f) => f.job === r.job).length;
    const [failing, flaky, unjudged] = [of(left.failing), of(left.flaky), of(left.unjudged)];
    const counts = [failing && `${failing} failing`, flaky && `${flaky} flaky (passed alone)`, unjudged && `${unjudged} not judged`].filter(Boolean);
    const logs = r.reason?.match(/\blogs \S+$/)?.[0];
    return { ...r, status: failing ? "fail" : unjudged ? "no verdict" : "pass", reason: [...counts, logs].filter(Boolean).join(", ") || undefined };
  });
}
