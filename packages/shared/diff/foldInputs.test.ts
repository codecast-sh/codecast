import { describe, expect, test } from "bun:test";
import { computeCumulativeFiles, selectFoldInputs, type CumulativeChange } from "./index";

type Change = CumulativeChange & { id: string };

// A deterministic generator: a few files, string edits and whole-file writes
// and deletes in any order, so the fold's every branch runs.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomHistory(seed: number, length: number): Change[] {
  const rng = makeRng(seed);
  const files = ["a.ts", "b.ts", "c.ts"];
  const changes: Change[] = [];
  for (let i = 0; i < length; i++) {
    const filePath = files[Math.floor(rng() * files.length)];
    const roll = rng();
    const text = `line${Math.floor(rng() * 5)}\n`;
    if (roll < 0.5) {
      changes.push({ id: `c${i}`, filePath, changeType: "edit", sequenceIndex: i, oldContent: `line${Math.floor(rng() * 5)}\n`, newContent: text });
    } else if (roll < 0.85) {
      changes.push({ id: `c${i}`, filePath, changeType: "write", sequenceIndex: i, oldContent: rng() < 0.5 ? undefined : `old${i}\n${text}`, newContent: `${text}new${i}\n` });
    } else if (roll < 0.95) {
      changes.push({ id: `c${i}`, filePath, changeType: "delete", sequenceIndex: i, oldContent: text, newContent: "" });
    } else {
      changes.push({ id: `c${i}`, filePath: "", changeType: "commit", sequenceIndex: i, newContent: "" });
    }
  }
  return changes;
}

describe("selectFoldInputs", () => {
  test("folding the selected inputs gives the same tree as folding the whole history", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const history = randomHistory(seed, 40);
      for (const upTo of [null, 0, 5, 17, 39]) {
        const expected = computeCumulativeFiles(history, upTo);
        const subset = selectFoldInputs(history, upTo);
        expect(computeCumulativeFiles(subset, null)).toEqual(expected);
      }
    }
  });

  test("a file rewritten whole many times needs two of its changes", () => {
    const history: Change[] = Array.from({ length: 200 }, (_, i) => ({
      id: `w${i}`, filePath: "big.ts", changeType: "write", sequenceIndex: i,
      oldContent: `v${i}\n`, newContent: `v${i + 1}\n`,
    }));
    const subset = selectFoldInputs(history, null);
    expect(subset.map((c) => c.id)).toEqual(["w0", "w199"]);
    expect(computeCumulativeFiles(subset, null)).toEqual(computeCumulativeFiles(history, null));
  });

  test("edits after the last whole-file write stay, edits before it go", () => {
    const history: Change[] = [
      { id: "e0", filePath: "f", changeType: "edit", sequenceIndex: 0, oldContent: "a", newContent: "b" },
      { id: "w1", filePath: "f", changeType: "write", sequenceIndex: 1, oldContent: "b\n", newContent: "c\n" },
      { id: "e2", filePath: "f", changeType: "edit", sequenceIndex: 2, oldContent: "c", newContent: "d" },
      { id: "w3", filePath: "f", changeType: "write", sequenceIndex: 3, oldContent: "d\n", newContent: "e\n" },
      { id: "e4", filePath: "f", changeType: "edit", sequenceIndex: 4, oldContent: "e", newContent: "f" },
      { id: "k5", filePath: "", changeType: "commit", sequenceIndex: 5, newContent: "" },
    ];
    expect(selectFoldInputs(history, null).map((c) => c.id)).toEqual(["e0", "w1", "w3", "e4"]);
    expect(selectFoldInputs(history, 2).map((c) => c.id)).toEqual(["e0", "w1", "e2"]);
    expect(selectFoldInputs(history, -1)).toEqual([]);
  });
});
