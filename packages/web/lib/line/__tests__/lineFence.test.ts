import { describe, expect, test } from "bun:test";
import { readLineFence } from "../lineFence";

describe("the line fence's spec", () => {
  test("reads a step widget", () => {
    const r = readLineFence(`{"widget":"step","project":"pr-12","graph":"agentwatch","step":"dissolve"}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec).toMatchObject({ widget: "step", project: "pr-12", graph: "agentwatch", step: "dissolve", run: null });
  });

  test("names what is wrong rather than drawing a broken widget", () => {
    expect(readLineFence("not json")).toEqual({ ok: false, why: "The block is not JSON." });
    expect(readLineFence("[1]")).toEqual({ ok: false, why: "The block is not a JSON object." });
    expect(readLineFence(`{"widget":"nope","project":"p"}`)).toEqual({ ok: false, why: `Unknown widget "nope".` });
    expect(readLineFence(`{"widget":"step"}`)).toEqual({ ok: false, why: "No project named." });
    expect(readLineFence(`{"widget":"decision","project":"p","step":"prove"}`)).toEqual({ ok: false, why: `A decision widget needs "run".` });
    expect(readLineFence(`{"widget":"diff","project":"p","step":"prove"}`)).toEqual({ ok: false, why: `A diff widget needs "after".` });
  });

  test("keeps a diff's texts as written and clamps a list's length", () => {
    const r = readLineFence(JSON.stringify({ widget: "diff", project: "p", step: "prove", after: "  new\n" }));
    expect(r.ok && r.spec.after).toBe("  new\n");
    const l = readLineFence(JSON.stringify({ widget: "decisions", project: "p", step: "prove", limit: 500 }));
    expect(l.ok && l.spec.limit).toBe(50);
  });

  test("a before/after table keeps rows that name a case", () => {
    const r = readLineFence(JSON.stringify({ widget: "before-after", project: "p", step: "prove", rows: [{ case: "ct-1", before: "a", after: "b" }, { before: "x" }, null] }));
    expect(r.ok && r.spec.rows).toEqual([{ case: "ct-1", before: "a", after: "b", ref: null }]);
  });
});

test("a before/after table needs its rows: there is nothing to compare without them", () => {
  expect(readLineFence(`{"widget":"before-after","project":"p","step":"prove"}`)).toEqual({ ok: false, why: `A before-after widget needs "rows".` });
});

test("a problem widget names its case: a cause's history, drawn wherever an answer about it renders", () => {
  const r = readLineFence(`{"widget":"problem","project":"p","case":"ct-57367"}`);
  expect(r.ok && r.spec.case).toBe("ct-57367");
  expect(readLineFence(`{"widget":"problem","project":"p"}`)).toEqual({ ok: false, why: `A problem widget needs "case".` });
});
