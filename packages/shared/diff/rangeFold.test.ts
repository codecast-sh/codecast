import { describe, expect, test } from "bun:test";
import {
  computeCumulativeDiff,
  computeCumulativeFiles,
  computeRangeFiles,
  diffBaseStart,
  generateUnifiedPatch,
  selectRangeFoldInputs,
  type CumulativeChange,
} from "./index";

type Change = CumulativeChange & { id: string; timestamp: number; commitBranch?: string };

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
    const base = { id: `c${i}`, sequenceIndex: i, timestamp: 1000 + i };
    if (roll < 0.5) {
      changes.push({ ...base, filePath, changeType: "edit", oldContent: `line${Math.floor(rng() * 5)}\n`, newContent: text });
    } else if (roll < 0.85) {
      changes.push({ ...base, filePath, changeType: "write", oldContent: rng() < 0.5 ? undefined : `old${i}\n${text}`, newContent: `${text}new${i}\n` });
    } else if (roll < 0.95) {
      changes.push({ ...base, filePath, changeType: "delete", oldContent: text, newContent: "" });
    } else {
      changes.push({ ...base, filePath: "git commit", changeType: "commit", newContent: "" });
    }
  }
  return changes;
}

const fold = (history: Change[], from: number, to: number | null) => {
  const { base, head } = selectRangeFoldInputs(history, from, to);
  return computeRangeFiles(base, head);
};
const unstamped = <T extends { contentHash: string }>(files: T[]) => files.map(({ contentHash: _h, ...f }) => f);

describe("computeRangeFiles", () => {
  test("from the start it is the whole-session fold", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const history = randomHistory(seed, 40);
      for (const to of [null, 5, 17, 39]) {
        expect(unstamped(fold(history, 0, to))).toEqual(computeCumulativeFiles(history, to));
      }
    }
  });

  test("the selected inputs fold the same as every change on each side", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const history = randomHistory(seed, 40);
      for (const [from, to] of [[3, null], [10, 30], [25, 39], [39, null]] as const) {
        const end = to ?? history.length - 1;
        const touched = new Set(history.slice(from, end + 1).filter((c) => c.changeType !== "commit").map((c) => c.filePath));
        const everyBase = history.slice(0, from).filter((c) => touched.has(c.filePath));
        const everyHead = history.slice(0, end + 1).filter((c) => touched.has(c.filePath));
        expect(fold(history, from, to)).toEqual(computeRangeFiles(everyBase, everyHead));
      }
    }
  });

  test("a file whose text at the boundary is known diffs that text against its latest", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const history = randomHistory(seed, 40);
      const from = 20;
      for (const file of fold(history, from, null)) {
        const before = history.slice(0, from).filter((c) => c.filePath === file.filename);
        if (!before.some((c) => c.changeType === "write" || c.changeType === "delete")) continue;
        const atBoundary = computeCumulativeDiff(before)[0];
        const latest = computeCumulativeDiff(history.filter((c) => c.filePath === file.filename))[0];
        const oldStr = atBoundary.deleted ? "" : atBoundary.newContent;
        const newStr = latest.deleted ? "" : latest.newContent;
        expect(file.patch).toBe(generateUnifiedPatch(file.filename, oldStr, newStr));
      }
    }
  });

  test("only the edits after the boundary show, against the file as it was there", () => {
    const history: Change[] = [
      { id: "w0", filePath: "f.ts", changeType: "write", sequenceIndex: 0, timestamp: 1, newContent: "one\ntwo\nthree\n" },
      { id: "e1", filePath: "f.ts", changeType: "edit", sequenceIndex: 1, timestamp: 2, oldContent: "one", newContent: "ONE" },
      { id: "k2", filePath: "git commit", changeType: "commit", sequenceIndex: 2, timestamp: 3, newContent: "" },
      { id: "e3", filePath: "f.ts", changeType: "edit", sequenceIndex: 3, timestamp: 4, oldContent: "three", newContent: "THREE" },
      { id: "w4", filePath: "g.ts", changeType: "write", sequenceIndex: 4, timestamp: 5, newContent: "new\n" },
    ];
    const files = fold(history, 3, null);
    expect(files.map((f) => [f.filename, f.status])).toEqual([["g.ts", "added"], ["f.ts", "modified"]]);
    const f = files.find((x) => x.filename === "f.ts")!;
    expect(f.patch).toContain("-three");
    expect(f.patch).toContain("+THREE");
    expect(f.patch).not.toContain("+ONE");
    expect(f.patch).toContain(" ONE");
  });

  test("a file's stamp follows its text at the end, not the base", () => {
    const history = randomHistory(11, 40);
    const stamps = (from: number) => new Map(fold(history, from, null).map((f) => [f.filename, f.contentHash]));
    const whole = stamps(0);
    for (const [file, hash] of stamps(25)) expect(whole.get(file)).toBe(hash);
    const edited: Change[] = [...history, { id: "x", filePath: "a.ts", changeType: "write", sequenceIndex: 40, timestamp: 2000, oldContent: "?", newContent: "something else\n" }];
    const after = new Map(fold(edited, 0, null).map((f) => [f.filename, f.contentHash]));
    expect(after.get("a.ts")).not.toBe(whole.get("a.ts"));
  });

  test("an empty range is an empty tree", () => {
    const history = randomHistory(7, 10);
    expect(fold(history, 10, null)).toEqual([]);
  });
});

describe("diffBaseStart", () => {
  const history: Change[] = [
    { id: "e0", filePath: "a", changeType: "edit", sequenceIndex: 0, timestamp: 100, oldContent: "x", newContent: "y" },
    { id: "k1", filePath: "git commit", changeType: "commit", sequenceIndex: 1, timestamp: 110, newContent: "", commitBranch: "main" },
    { id: "e2", filePath: "a", changeType: "edit", sequenceIndex: 2, timestamp: 120, oldContent: "y", newContent: "z" },
    { id: "k3", filePath: "git commit", changeType: "commit", sequenceIndex: 3, timestamp: 130, newContent: "", commitBranch: "feature" },
    { id: "e4", filePath: "a", changeType: "edit", sequenceIndex: 4, timestamp: 140, oldContent: "z", newContent: "w" },
  ];

  test("session starts at the first change", () => {
    expect(diffBaseStart(history, "session")).toBe(0);
  });

  test("last commit starts right after the newest commit", () => {
    expect(diffBaseStart(history, "commit")).toBe(4);
    expect(diffBaseStart(history.filter((c) => c.changeType !== "commit"), "commit")).toBeNull();
  });

  test("branch base starts after the last commit on the default branch", () => {
    expect(diffBaseStart(history, "branch")).toBe(2);
    expect(diffBaseStart(history, "branch", { defaultBranch: "feature" })).toBe(4);
  });

  test("a commit that does not name its branch takes the session's", () => {
    const unnamed = history.map(({ commitBranch: _b, ...c }) => c);
    expect(diffBaseStart(unnamed, "branch", { branch: "main" })).toBe(4);
    expect(diffBaseStart(unnamed, "branch", { branch: "feature" })).toBe(0);
    expect(diffBaseStart(unnamed, "branch")).toBe(0);
  });

  test("last turn starts at the first change since the person spoke", () => {
    expect(diffBaseStart(history, "turn", { turnStartedAt: 125 })).toBe(3);
    expect(diffBaseStart(history, "turn", { turnStartedAt: 500 })).toBe(history.length);
    expect(diffBaseStart(history, "turn")).toBeNull();
  });
});
