// Parity with the speech lab (packages/evals/speech/lab/identify.py): the
// clean windows chosen per voice and the names the matcher gives, on AMI
// fixtures exported by export_fixture.py. Fixtures from real team voices
// (cl-*) stay in ~/.codecast/diarize-lab/fixtures and run only where present.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { budgetWindows, cleanWindows, CLUSTER_SECONDS, matchVoices, maxAssignment, turnsFromLabeledWords } from "./voiceMatch";

const REPO = join(import.meta.dir, "..", "..", "test-fixtures", "voiceMatch");
const LOCAL = join(homedir(), ".codecast", "diarize-lab", "fixtures");
const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function check(fx: any) {
  const turns = fx.turns.map((t: any) => ({ key: t.speaker, start: t.start, end: t.end }));
  const wins = cleanWindows(turns);
  for (const [key, chosen] of Object.entries(fx.clusters) as Array<[string, any[]]>) {
    const got = budgetWindows(wins.get(key) ?? [], CLUSTER_SECONDS);
    expect(got.length).toBe(chosen.length);
    got.forEach(([s, e], i) => {
      expect(Math.abs(s - chosen[i].start)).toBeLessThan(1e-9);
      expect(Math.abs(e - chosen[i].end)).toBeLessThan(1e-9);
    });
  }
  const clusters = new Map(Object.entries(fx.clusters).map(([k, ws]: [string, any]) => [k, ws.map((w: any) => w.vector)]));
  const prints = new Map(Object.entries(fx.prints) as Array<[string, number[][]]>);
  const { names, scores } = matchVoices(clusters, prints, { threshold: fx.threshold, margin: fx.margin });
  for (const [key, want] of Object.entries(fx.expected)) expect([key, names.get(key) ?? null]).toEqual([key, want as any]);
  // Scores agree with the lab's to the vectors' rounding.
  for (const [key, row] of Object.entries(fx.scores) as Array<[string, Record<string, number>]>) {
    for (const [p, s] of Object.entries(row)) expect(Math.abs(scores.get(key)!.get(p)! - s)).toBeLessThan(2e-3);
  }
  return Object.fromEntries(names);
}

describe("voice match parity with the speech lab", () => {
  for (const name of ["IS1009b.json", "IS1009b-drop0.json"]) {
    test(`AMI ${name}: windows and names`, () => {
      check(load(join(REPO, name)));
    });
  }
  test("an unenrolled speaker stays unnamed", () => {
    const fx = load(join(REPO, "IS1009b-drop0.json"));
    expect(Object.values(fx.expected)).toContain(null);
  });

  for (const name of ["ES2004c.json", "cl-180-0.json", "cl-137-0.json"]) {
    const path = join(LOCAL, name);
    test.skipIf(!existsSync(path))(`local ${name}: windows and names`, () => {
      const names = check(load(path));
      console.log(`[voiceMatch parity] ${name}`, JSON.stringify(names));
    });
  }
});

describe("matcher pieces", () => {
  test("the assignment maximizes the total, rectangular either way", () => {
    expect(maxAssignment([[0.9, 0.8], [0.85, 0.1]])).toEqual([[0, 1], [1, 0]]);
    expect(maxAssignment([[0.2], [0.7], [0.5]])).toEqual([[1, 0]]);
    expect(maxAssignment([[0.1, 0.6, 0.3]])).toEqual([[0, 1]]);
  });

  test("a pair below the threshold or too close to the runner-up stays unnamed", () => {
    const v = (x: number, y: number) => [[x, y]];
    const prints = new Map([["ann", v(1, 0)], ["bob", v(0.98, 0.2)]]);
    // Close to both: margin fails.
    expect(matchVoices(new Map([["spk:0", v(1, 0.1)]]), prints).names.get("spk:0")).toBeNull();
    // Clear of Bob, close to Ann.
    expect(matchVoices(new Map([["spk:0", v(1, -0.5)]]), prints).names.get("spk:0")).toBe("ann");
    // Nobody close.
    expect(matchVoices(new Map([["spk:0", v(-1, 0)]]), prints).names.get("spk:0")).toBeNull();
  });

  test("turns from labeled words split on a voice change or a 0.5 s gap", () => {
    expect(
      turnsFromLabeledWords([
        { start: 0, end: 0.3, key: "spk:0" }, { start: 0.4, end: 0.6, key: "spk:0" },
        { start: 0.7, end: 1, key: "spk:1" }, { start: 1.6, end: 1.8, key: "spk:1" },
      ]),
    ).toEqual([
      { key: "spk:0", start: 0, end: 0.6 }, { key: "spk:1", start: 0.7, end: 1 }, { key: "spk:1", start: 1.6, end: 1.8 },
    ]);
  });
});
