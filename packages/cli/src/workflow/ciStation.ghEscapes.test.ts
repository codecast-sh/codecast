import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCiStation, type Gh } from "./ciStation.js";
import { BUN_LOG, BUN_TEST, HEAD, MAIN, NOW, check, fakeGh, mergeLog } from "./ciStation.testkit.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function station(gh: Gh) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-station-"));
  dirs.push(dir);
  let clock = NOW;
  return runCiStation({ pr: 7, dir, deadlineMs: 60 * 60_000, gh, now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 30_000 });
}

describe("cast flow ci: job logs carry terminal escapes", () => {
  // As Actions serves it: bun's colours around the markers the parser reads.
  const colouredLog = BUN_LOG.replace(/\(fail\)/g, "\x1b[31m(fail)\x1b[0m").replace(/error:/g, "\x1b[31merror:\x1b[0m");
  const red = (escapes: "required" | "unknown") => fakeGh({
    polls: [{ rollup: [check("lint", "SUCCESS", 1, 1), check("test-cli", "FAILURE", 2)] }],
    fail: (a) => (a.startsWith("run rerun") ? { code: 1, out: "no" } : null),
    logs: { 1: mergeLog(HEAD, MAIN), 2: colouredLog },
    escapes,
  });
  const logReads = (gh: { calls: string[] }) => gh.calls.filter((c) => c.includes("/logs"));
  const named = [expect.objectContaining({ job: "test-cli", test: BUN_TEST, file: "packages/cli/src/bench/bootGraph.guard.test.ts", line: 723 })];

  test("gh 2.105, which refuses escapes without --allow-escape-sequences: the log still names the failure", async () => {
    const gh = red("required");
    const { result } = await station(gh);
    expect(result.tested_main_sha).toBe(MAIN);
    expect(result.failing).toEqual(named);
    expect(logReads(gh).every((c) => c.endsWith(" --allow-escape-sequences"))).toBe(true);
  });

  test("a gh older than the flag rejects it: one retry without it, and no later read passes it", async () => {
    const gh = red("unknown");
    const { result } = await station(gh);
    expect(result.tested_main_sha).toBe(MAIN);
    expect(result.failing).toEqual(named);
    const reads = logReads(gh);
    expect(reads.filter((c) => c.endsWith(" --allow-escape-sequences"))).toHaveLength(1);
    expect(reads.filter((c) => c.includes("jobs/2/logs") && !c.includes("--allow"))).toHaveLength(1);
  });
});
