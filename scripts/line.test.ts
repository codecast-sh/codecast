// codecast's prove command (scripts/line.ts, line-profile.md LP4): the replay
// JSON it reads, and the majority rule a miss and a guard are held to.
import { describe, expect, test } from "bun:test";
import { provenEntry, replayRuns } from "./line";

const run = (status: string, score: number | null = null) => ({ status, score, gatesFailed: [], missedFloors: [] }) as any;

describe("scripts/line.ts prove", () => {
  test("reads the JSON array --json prints after the replay's progress lines", () => {
    const out = `[1/3] replaying fz-1\nrep 1 PASS\n${JSON.stringify([run("pass"), run("fail")], null, 2)}\n`;
    expect(replayRuns(out)?.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(replayRuns("[]\n")).toEqual([]);
    expect(replayRuns("no json here")).toBeNull();
  });

  test("a miss is shown when it fails by majority; a guard holds when it passes by majority; crashes count for nothing", () => {
    expect(provenEntry("fz-1", "miss", [run("fail"), run("fail"), run("pass")])).toEqual({ freeze: "fz-1", kind: "miss", passed: 1, scored: 3, ok: true });
    expect(provenEntry("fz-1", "miss", [run("pass"), run("pass"), run("fail")]).ok).toBe(false);
    // A tie is no pass, so a tied miss is shown and a tied guard does not hold.
    expect(provenEntry("fz-1", "miss", [run("pass"), run("fail")]).ok).toBe(true);
    expect(provenEntry("g-1", "guard", [run("pass"), run("fail")]).ok).toBe(false);
    expect(provenEntry("g-1", "guard", [run("pass"), run("pass"), run("crash")])).toEqual({ freeze: "g-1", kind: "guard", passed: 2, scored: 2, ok: true });
    expect(provenEntry("fz-2", "miss", [run("crash")])).toEqual({ freeze: "fz-2", kind: "miss", passed: 0, scored: 0, ok: false, error: "no rep scored" });
  });
});
