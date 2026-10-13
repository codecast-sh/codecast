import { describe, expect, test } from "bun:test";
import { numberedWaveError, parseStepLines, planTail, stepsFromWaves, templateSteps } from "./planSteps";

/** The parsed steps' text alone. */
const stepTexts = (text: string) => parseStepLines(text).map((wave) => wave.map((l) => l.text));

describe("parseStepLines", () => {
  test("a blank line starts a wave; runs of blank lines and edges count once", () => {
    const text = "\nDesign the schema\n\n\nBuild the API\nBuild the UI\n  \nReview in the real app\n\n";
    expect(stepTexts(text)).toEqual([["Design the schema"], ["Build the API", "Build the UI"], ["Review in the real app"]]);
  });

  test("list markers are dropped, a number inside a title is kept", () => {
    expect(stepTexts("- Ship 2.0 notes\n* Tag\n\n1. Announce\n2) Watch")).toEqual([["Ship 2.0 notes", "Tag"], ["Announce", "Watch"]]);
  });

  test("CRLF input and empty input", () => {
    expect(stepTexts("A\r\n\r\nB")).toEqual([["A"], ["B"]]);
    expect(stepTexts("  \n\n")).toEqual([]);
  });
});

describe("numberedWaveError", () => {
  test("numbered lines in one wave read as an order, so they are refused", () => {
    expect(numberedWaveError(parseStepLines("1. Design\n2. Build\n3. Review"))).toMatch(/^Numbered steps on consecutive lines run in parallel \("Design", "Build"\)\. Put a blank line/);
  });

  test("numbered waves, bulleted lines, a lone number and a version are fine", () => {
    for (const text of ["1. Design\n\n2. Build", "- API\n- UI", "1. Design\nBuild", "Ship 2.0 notes\nTag"]) {
      expect(numberedWaveError(parseStepLines(text))).toBeNull();
    }
  });
});

describe("stepsFromWaves", () => {
  test("each step needs every step of the wave before, none of its own wave", () => {
    const steps = stepsFromWaves([["Design"], ["API", "UI"], ["Review"]]);
    expect(steps.map((s) => [s.title, s.after])).toEqual([
      ["Design", []],
      ["API", [0]],
      ["UI", [0]],
      ["Review", [1, 2]],
    ]);
  });

  test("a line carries its description after ' :: '", () => {
    expect(stepsFromWaves([["Build the API :: GET /x returns 200; owns api.ts", "Docs ::", "Ship\t::  it", "a::b"]])).toEqual([
      { title: "Build the API", description: "GET /x returns 200; owns api.ts", after: [] },
      { title: "Docs", after: [] },
      { title: "Ship", description: "it", after: [] },
      { title: "a::b", after: [] },
    ]);
  });
});

describe("planTail", () => {
  const t = (short_id: string, status: string, blocked_by: string[] = [], _id?: string) => ({ short_id, status, blocked_by, _id });

  test("open tasks nothing open waits on", () => {
    const tasks = [t("ct-1", "done"), t("ct-2", "in_progress", ["ct-1"]), t("ct-3", "open", ["ct-2"]), t("ct-4", "open", ["ct-2"])];
    expect(planTail(tasks).map((x) => x.short_id)).toEqual(["ct-3", "ct-4"]);
  });

  test("a task waited on only by finished work is still the tail", () => {
    const tasks = [t("ct-1", "open"), t("ct-2", "dropped", ["ct-1"])];
    expect(planTail(tasks).map((x) => x.short_id)).toEqual(["ct-1"]);
  });

  test("an edge by _id counts; backlog and closed tasks are not waited on", () => {
    const tasks = [t("ct-1", "open", [], "id1"), t("ct-2", "open", ["id1"]), t("ct-3", "backlog"), t("ct-4", "done")];
    expect(planTail(tasks).map((x) => x.short_id)).toEqual(["ct-2"]);
    expect(planTail([t("ct-9", "done")])).toEqual([]);
  });
});

describe("templateSteps", () => {
  test("orders so every edge points back, edges as indices", () => {
    // ct-3 is listed first but needs ct-1 and ct-2.
    const tasks = [
      { short_id: "ct-3", blocked_by: ["ct-1", "ct-2"] },
      { short_id: "ct-1", blocked_by: [] },
      { short_id: "ct-2", blocked_by: ["ct-1", "ct-99"] },
    ];
    expect(templateSteps(tasks).map((s) => [s.task.short_id, s.blocked_by_indices])).toEqual([
      ["ct-1", []],
      ["ct-2", [0]],
      ["ct-3", [0, 1]],
    ]);
  });

  test("a skipped step passes its blockers through: A → B (dropped) → C keeps C after A", () => {
    const tasks = [
      { short_id: "ct-3", blocked_by: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1"], status: "dropped" },
      { short_id: "ct-1", blocked_by: [] },
      { short_id: "ct-4", blocked_by: ["ct-5"], status: "dropped" },
      { short_id: "ct-5", blocked_by: ["ct-4"], status: "dropped" },
    ];
    expect(templateSteps(tasks, (t) => t.status === "dropped").map((s) => [s.task.short_id, s.blocked_by_indices])).toEqual([
      ["ct-1", []],
      ["ct-3", [0]],
    ]);
  });

  test("a loop comes last without its back edges", () => {
    const tasks = [
      { short_id: "ct-1", blocked_by: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
      { short_id: "ct-3", blocked_by: [] },
    ];
    const out = templateSteps(tasks);
    expect(out.map((s) => s.task.short_id)).toEqual(["ct-3", "ct-1", "ct-2"]);
    for (const [i, s] of out.entries()) expect(s.blocked_by_indices.every((j) => j < i)).toBe(true);
  });
});
