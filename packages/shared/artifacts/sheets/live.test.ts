import { describe, expect, test } from "bun:test";
import { LiveSheet, buildModel, workbookFor } from "./model";
import type { ArtifactElement } from "../core";

const el = (key: string, kind: string, f: Record<string, unknown>): ArtifactElement => ({ key, kind, rev: 1, ...f }) as ArtifactElement;

describe("LiveSheet", () => {
  test("incremental updates match a full rebuild", () => {
    let els: ArtifactElement[] = [el("tab:Sheet1", "tab", { name: "Main", order: 0 })];
    for (let r = 1; r <= 30; r++) els.push(el(`c:Sheet1!A${r}`, "cell", { input: String(r) }), el(`c:Sheet1!B${r}`, "cell", { input: `=A${r}*2+SUM(A1:A30)` }));
    const live = new LiveSheet();
    live.update(els);
    const steps: Array<(e: ArtifactElement[]) => ArtifactElement[]> = [
      (e) => e.map((x) => (x.key === "c:Sheet1!A3" ? el(x.key, "cell", { input: "100" }) : x)),
      (e) => e.filter((x) => x.key !== "c:Sheet1!A4"),
      (e) => [...e, el("tab:t1", "tab", { name: "Other", order: 1 }), el("c:t1!A1", "cell", { input: "=Main!B3" })],
      (e) => e.map((x) => (x.key === "tab:Sheet1" ? el(x.key, "tab", { name: "Renamed", order: 0, frozen_rows: 1 }) : x)),
      (e) => [...e, el("col:Sheet1!B", "col", { w: 200 }), el("cf:x", "cf", { tab: "Sheet1", range: "B1:B30", rule: "sign" })],
      (e) => e.filter((x) => x.key !== "col:Sheet1!B"),
    ];
    let prevModel = live.model;
    for (const step of steps) {
      els = step(els);
      live.update(els);
      const full = buildModel(els);
      const wb = workbookFor(full);
      expect(live.model.tabs).toEqual(full.tabs);
      expect(live.model.conds).toEqual(full.conds);
      for (const [id, t] of full.byId) {
        const lt = live.model.byId.get(id)!;
        expect([...lt.cells.keys()].sort()).toEqual([...t.cells.keys()].sort());
        expect([...lt.colWidths]).toEqual([...t.colWidths]);
        for (let r = 1; r <= 30; r++) for (let c = 1; c <= 2; c++) expect(live.wb.value(id, c, r)).toEqual(wb.value(id, c, r));
      }
      expect(live.model).not.toBe(prevModel);
      prevModel = live.model;
    }
    expect(live.update(els)).toBe(false);
  });
});

describe("format inheritance", () => {
  test("a formula over a formatted cell reads in that format", async () => {
    const { inheritedFormat } = await import("./model");
    const m = buildModel([
      el("c:Sheet1!A1", "cell", { input: "1200", nf: "currency" }),
      el("c:Sheet1!A2", "cell", { input: "=A1*2" }),
      el("c:Sheet1!A3", "cell", { input: "=A2+1" }),
      el("c:Sheet1!B1", "cell", { input: "10%" }),
      el("c:Sheet1!B2", "cell", { input: "=B1*2" }),
      el("c:Sheet1!C1", "cell", { input: "=A1>5" }),
    ]);
    expect(inheritedFormat(m, "Sheet1", "=A1*2")).toEqual({ nf: "currency", dp: undefined });
    expect(inheritedFormat(m, "Sheet1", "=A2+1")).toEqual({ nf: "currency", dp: undefined });
    expect(inheritedFormat(m, "Sheet1", "=B1*2")).toEqual({ nf: "percent", dp: 0 });
    expect(inheritedFormat(m, "Sheet1", "=A1>5")).toBeUndefined();
  });
});

describe("round 3 fixes", () => {
  test("COUNT over percents is a count, SUM keeps the unit", async () => {
    const { inheritedFormat } = await import("./model");
    const m = buildModel([el("c:Sheet1!A1", "cell", { input: "10%" }), el("c:Sheet1!A2", "cell", { input: "20%" })]);
    expect(inheritedFormat(m, "Sheet1", "=COUNT(A1:A2)")).toBeUndefined();
    expect(inheritedFormat(m, "Sheet1", "=SUM(A1:A2)")).toEqual({ nf: "percent", dp: 0 });
    expect(inheritedFormat(m, "Sheet1", "=IF(A1>0,A2,0)")).toEqual({ nf: "percent", dp: 0 });
    expect(inheritedFormat(m, "Sheet1", "=A1>0")).toBeUndefined();
  });
  test("a cell on an undeclared tab shows up in the tab list", () => {
    const live = new LiveSheet();
    const els = [el("tab:Sheet1", "tab", { name: "Main", order: 0 }), el("c:Sheet1!A1", "cell", { input: "1" })];
    live.update(els);
    live.update([...els, el("c:t9!A1", "cell", { input: "=Main!A1" })]);
    expect(live.model.tabs.map((t) => t.id)).toContain("t9");
    expect(live.wb.value("t9", 1, 1)).toBe(1);
  });
});

describe("agent writes per tab", () => {
  test("each tab knows its newest agent write, incrementally and on rebuild", () => {
    const w = (key: string, rev: number, by?: string) => ({ ...el(key, "cell", { input: "1" }), rev, by, at: rev * 10 }) as ArtifactElement;
    let els: ArtifactElement[] = [el("tab:a", "tab", { name: "A", order: 0 }), el("tab:b", "tab", { name: "B", order: 1 }), w("c:a!A1", 1, "u:x:t"), w("c:b!A1", 2, "s:conv1")];
    for (let i = 2; i < 12; i++) els.push(w(`c:a!A${i}`, 2 + i, "u:x:t"));
    const live = new LiveSheet();
    live.update(els);
    expect(live.model.byId.get("a")!.agentWrite).toBeUndefined();
    expect(live.model.byId.get("b")!.agentWrite).toEqual({ rev: 2, by: "s:conv1", at: 20 });
    els = [...els, w("c:a!B1", 50, "s:conv2")];
    live.update(els);
    expect(live.model.byId.get("a")!.agentWrite).toEqual({ rev: 50, by: "s:conv2", at: 500 });
    expect(buildModel(els).byId.get("a")!.agentWrite).toEqual({ rev: 50, by: "s:conv2", at: 500 });
  });
});
