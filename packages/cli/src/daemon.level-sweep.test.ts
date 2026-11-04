import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codeLines, functionBlock, intervalBlocks } from "./test-helpers/sourceRegion.js";

// The level sweep keeps shared and line checkouts on their upstream. It rode
// the session heartbeat's maintenance pass, which runs only while a session is
// registered, so a line host whose runs all waited at a hold (no session on it)
// never levelled: line-4 stayed behind a pushed commit for six hours on Nov 2
// while its holds read their scripts from that checkout.

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

function runLevelSweepWith(deps: { sweep: (ids: string[]) => Promise<void>; sessions: () => string[]; log: (m: string) => void }) {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(functionBlock(source, "runLevelSweep").text);
  return new Function("levelSweepInProgress", "sweepLevelCheckouts", "currentHeartbeatSessions", "log", `${code}; return runLevelSweep;`)(
    false, deps.sweep, deps.sessions, deps.log,
  ) as () => Promise<void>;
}

describe("the level sweep's clock", () => {
  test("only runLevelSweep calls the sweep, so no session gate sits in front of it", () => {
    const callers = codeLines(source)
      .filter(({ line }) => line.includes("sweepLevelCheckouts(") && !/function\s+sweepLevelCheckouts\(/.test(line))
      .map(({ n }) => n);
    const own = functionBlock(source, "runLevelSweep");
    expect(callers.length).toBe(1);
    expect(callers[0]).toBeGreaterThan(own.startLine);
    expect(callers[0]).toBeLessThan(own.endLine);
  });

  test("daemon start arms it on its own interval", () => {
    const main = functionBlock(source, "main");
    const lineStart = (n: number) => source.split("\n").slice(0, n - 1).join("\n").length + 1;
    const timers = intervalBlocks(source, lineStart(main.startLine), lineStart(main.endLine));
    expect(timers.some((t) => /runLevelSweep\(\)/.test(t.text) && /LEVEL_SWEEP_INTERVAL_MS/.test(t.text))).toBe(true);
  });

  test("a pass with no session still sweeps the configured checkouts", async () => {
    const seen: string[][] = [];
    const run = runLevelSweepWith({ sweep: async (ids) => { seen.push(ids); }, sessions: () => [], log: () => {} });
    await run();
    expect(seen).toEqual([[]]);
  });

  test("a pass never overlaps the one still running, and a failed pass frees the next", async () => {
    let release!: () => void;
    let calls = 0;
    const logs: string[] = [];
    const run = runLevelSweepWith({
      sweep: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => { release = r; });
        if (calls === 2) throw new Error("fetch failed");
      },
      sessions: () => ["s1"],
      log: (m) => logs.push(m),
    });
    const first = run();
    await run();
    expect(calls).toBe(1);
    release();
    await first;
    await run();
    expect(calls).toBe(2);
    expect(logs).toEqual(["[LEVEL] pass error: fetch failed"]);
    await run();
    expect(calls).toBe(3);
  });
});
