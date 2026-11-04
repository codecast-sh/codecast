import { describe, expect, test } from "bun:test";
import { issueFixLedger } from "./issueFix";

const base = { refs: ["eg-1557", "eg-299"], title: "Boom", project: "union", task: "ct-1", running: 0, prompt: "Fix it", showPrompt: false, togglePrompt: () => {} };

describe("the fix review's ledger", () => {
  test("an unpriced run shows no cost figure at all", () => {
    const l = issueFixLedger(base);
    expect(l.figures.map((f) => f.value)).toEqual(["1"]);
    expect(l.rows.some((r) => r.k === "List price")).toBe(false);
  });

  test("several folders become the review's pick, and the folder row steps aside", () => {
    const l = issueFixLedger({ ...base, folders: ["union", "union-mobile", "codecast"], fromSource: true });
    expect(l.pick).toEqual({ k: "Folder", options: ["union", "union-mobile", "codecast"], value: "union" });
    expect(l.rows.some((r) => r.k === "Folder")).toBe(false);
  });

  test("a selection whose tasks differ lists them, marks the one it binds to, and offers the next", () => {
    const press = () => {};
    const l = issueFixLedger({ ...base, tasks: ["ct-1", "ct-2"], nextTask: { label: "Use ct-2", press }, unfiled: 1 });
    const works = l.rows.find((r) => r.k === "Works on")!;
    expect(works.v).toBe("ct-1");
    expect(works.list).toEqual(["ct-1 · binds", "ct-2"]);
    expect(works.act?.label).toBe("Use ct-2");
    expect(l.rows.find((r) => r.k === "Unfiled")?.v).toBe("1 of 2 have no task");
  });

  test("a selection reads one line per issue with its task, state and mismatch, and the folder pick keeps its whole label", () => {
    const l = issueFixLedger({
      ...base,
      task: "ct-70858",
      folders: ["union", "codecast"],
      fromSource: false,
      issues: [
        { ref: "eg-299", task: "ct-70858", state: "open" },
        { ref: "eg-607", task: "ct-58659", state: "in review", mismatch: true },
        { ref: "eg-1", task: null },
      ],
    });
    const works = l.rows.find((r) => r.k === "Works on")!;
    expect(works.tone).toBeUndefined();
    expect(works.list).toEqual(["eg-299 · ct-70858 open · binds", "eg-607 · ct-58659 in review · other title", "eg-1 · no task"]);
    expect(l.pick?.k).toBe("Folder");
    expect(l.rows.find((r) => r.k === "Source folder")).toBeUndefined();
  });

  test("a task filed for another title is flagged where it binds", () => {
    const l = issueFixLedger({ ...base, refs: ["eg-607"], task: "ct-58659", taskMismatch: true });
    expect(l.rows.find((r) => r.k === "Works on")).toMatchObject({ v: "ct-58659 · other issue's task", tone: "warn" });
  });
});

describe("a selection of unrelated issues", () => {
  const base = { refs: ["eg-299", "eg-607", "eg-71"], title: "Exceptions", project: "union", task: null, running: 0, prompt: "x", showPrompt: false, togglePrompt: () => {} };
  test("starts one session per issue, each on its own task, and offers one for all", () => {
    const l = issueFixLedger({ ...base, sessions: 3, splitToggle: { label: "One session for all", press: () => {} }, issues: [{ ref: "eg-299", task: "ct-1" }, { ref: "eg-607", task: "ct-2" }, { ref: "eg-71", task: null }] });
    expect(l.figures[0]).toEqual({ value: "3", label: "sessions start now" });
    const works = l.rows.find((r) => r.k === "Works on")!;
    expect(works.v).toBe("Each its own task");
    expect(works.list).toEqual(["eg-299 · ct-1 · binds", "eg-607 · ct-2 · binds", "eg-71 · unbound"]);
    expect(l.rows.find((r) => r.k === "Sessions")?.act?.label).toBe("One session for all");
  });

  test("issues from different sources each start in their own folder, and the press counts the sessions", () => {
    const l = issueFixLedger({ ...base, refs: ["eg-71", "eg-884"], sessions: 2, folders: ["union-mobile", "union"], perFolder: [{ ref: "eg-71", folder: "union-mobile" }, { ref: "eg-884", folder: "union" }] });
    expect(l.confirm).toBe("Start 2 sessions");
    expect(l.pick).toBeUndefined();
    expect(l.rows.find((r) => r.k === "Folders")?.list).toEqual(["eg-71 · union-mobile", "eg-884 · union"]);
  });

  test("a start on a closed task says it reopens it", () => {
    const l = issueFixLedger({ ...base, refs: ["eg-118"], reopens: ["ct-57171"] });
    expect(l.rows.find((r) => r.k === "Reopens")?.v).toBe("ct-57171");
    expect(l.confirm).toBe("Reopen and start");
  });
});
