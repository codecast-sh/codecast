import { describe, expect, test } from "bun:test";
import { overviewWords } from "../../../components/line/LineProjects";
import type { RollupRow } from "../../lineFlow";

const row = (over: Partial<RollupRow> = {}): RollupRow => ({ key: "p", title: "P", signalsDay: 0, causes: 0, build: 0, awaiting: 0, watching: 0, closed: 0, finders: 0, silent: 0, undeclared: [], hold: null, stalled: 0, failing: false, graphs: [], neverRun: 0, startingOff: false, ...over });

describe("a project's line in words, on the overview", () => {
  test("what waits on you, what is stuck, what it is doing", () => {
    const w = overviewWords(row({ awaiting: 1, causes: 3, hold: "no one is in charge of this project's line, so nothing starts on its own", build: 2, watching: 1, closed: 4 }));
    expect(w.needsYou).toBe("1 finished fix waits for your decision");
    expect(w.stuck).toBe("3 problems wait to start: no one is in charge of this project's line, so nothing starts on its own");
    expect(w.doing).toBe("2 problems being worked on, 1 shipped fix being watched, 4 closed this week");
  });
  test("a reason every line shares is left to the summary, and the card counts its queue in the neutral line", () => {
    const w = overviewWords(row({ causes: 2, hold: "x" }), "x");
    expect(w.stuck).toBeNull();
    expect(w.doing).toBe("Nothing being worked on, 2 waiting to start");
  });
  test("quiet and stalled", () => {
    expect(overviewWords(row()).doing).toBe("Nothing being worked on");
    expect(overviewWords(row({ stalled: 1 })).stuck).toBe("1 run has said nothing for a day");
  });
});
