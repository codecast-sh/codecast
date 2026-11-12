// Starter sheets a person can create from a picker: a project tracker, a
// budget and a timesheet. Each builds a whole doc (its tab included) from the
// same ops the grid and the CLI write, so a template is an ordinary sheet.
import { foldOps, toElement, type ArtifactOp } from "../core";
import { newElementKey } from "../spec";
import { DEFAULT_TAB, colKey, tabKey, type Rect } from "./refs";
import { buildModel, type SheetModel } from "./model";
import { gridOps, styleOps, tabPatchOps } from "./ops";
import { condOps, validationOps } from "./ruleOps";
import { serialToDate, todaySerial } from "./values";

export type SheetTemplate = { id: string; label: string; ops: (now?: Date) => ArtifactOp[] };

/** Ops written in steps, each step reading the model the earlier ones made. */
function builder(tabName: string) {
  const ops: ArtifactOp[] = [{ k: tabKey(DEFAULT_TAB), put: { kind: "tab", name: tabName, order: 0 } }];
  const model = (): SheetModel => buildModel([...foldOps(new Map(), ops)].map(([k, st]) => toElement(k, st)));
  const add = (step: (m: SheetModel) => ArtifactOp[]) => ops.push(...step(model()));
  return { ops, add };
}

const rect = (c0: number, r0: number, c1: number, r1: number): Rect => ({ c0, r0, c1, r1 });
const widths = (w: number[]): ArtifactOp[] => w.map((px, i) => ({ k: colKey(DEFAULT_TAB, i + 1), put: { kind: "col", w: px } }));
const table = (range: string, color: string): ArtifactOp => ({ k: newElementKey("tbl"), put: { kind: "table", tab: DEFAULT_TAB, range, color, banded: true } });

function iso(serial: number): string {
  const d = serialToDate(serial);
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

function tracker(now = new Date()): ArtifactOp[] {
  const today = todaySerial(now);
  const b = builder("Tracker");
  const rows = [
    ["Task", "Owner", "Status", "Priority", "Due", "Notes"],
    ["Write the launch brief", "Ana", "Done", "High", iso(today - 6), "Shared in #launch"],
    ["Design the landing page", "Bo", "In progress", "High", iso(today + 2), ""],
    ["Set up analytics", "Cy", "Not started", "Medium", iso(today + 5), ""],
    ["Draft the announcement", "Ana", "Blocked", "Medium", iso(today - 1), "Waiting on pricing"],
    ["Plan the follow-up email", "Dee", "Not started", "Low", iso(today + 12), ""],
  ];
  b.add((m) => gridOps(m, DEFAULT_TAB, 1, 1, rows));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(1, 1, 6, 1), { b: true }));
  b.add((m) => validationOps(m, DEFAULT_TAB, rect(3, 2, 3, 200), "list", [{ v: "Not started", color: "gray" }, { v: "In progress", color: "blue" }, { v: "Blocked", color: "red" }, { v: "Done", color: "green" }]));
  b.add((m) => validationOps(m, DEFAULT_TAB, rect(4, 2, 4, 200), "list", [{ v: "High", color: "orange" }, { v: "Medium", color: "yellow" }, { v: "Low", color: "gray" }]));
  b.add((m) => validationOps(m, DEFAULT_TAB, rect(5, 2, 5, 200), "date"));
  // Overdue: past its date and not done.
  b.add((m) => condOps(m, DEFAULT_TAB, rect(5, 2, 5, 200), "formula", '=AND(ISNUMBER($E2),$E2<TODAY(),$C2<>"Done")', "red"));
  b.add((m) => tabPatchOps(m, DEFAULT_TAB, { frozen_rows: 1 }));
  b.ops.push(table("A1:F6", "blue"), ...widths([220, 100, 130, 100, 110, 200]));
  return b.ops;
}

function budget(): ArtifactOp[] {
  const b = builder("Budget");
  const items = [["Rent", 2400, 2400], ["Payroll", 18000, 17650], ["Software", 900, 1130], ["Marketing", 3000, 2210], ["Travel", 1200, 1480], ["Office supplies", 300, 145]];
  const rows: string[][] = [["Category", "Budgeted", "Actual", "Difference", "Used"]];
  items.forEach(([name, plan, actual], i) => rows.push([String(name), String(plan), String(actual), `=B${i + 2}-C${i + 2}`, `=IF(B${i + 2}=0,0,C${i + 2}/B${i + 2})`]));
  const total = items.length + 2;
  // Totals sum from row 2 down to the row above them, so a line inserted above Total counts too.
  const above = (c: string) => `=SUM(OFFSET(${c}2,0,0,ROW()-ROW(${c}2)))`;
  rows.push(["Total", above("B"), above("C"), `=B${total}-C${total}`, `=IF(B${total}=0,0,C${total}/B${total})`]);
  b.add((m) => gridOps(m, DEFAULT_TAB, 1, 1, rows));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(1, 1, 5, 1), { b: true }));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(1, total, 5, total), { b: true, bd: "t" }));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(2, 2, 4, total), { nf: "currency", dp: 0 }));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(5, 2, 5, total), { nf: "percent", dp: 0 }));
  // Under budget green, over budget red.
  b.add((m) => condOps(m, DEFAULT_TAB, rect(4, 2, 4, total), "sign"));
  b.add((m) => condOps(m, DEFAULT_TAB, rect(5, 2, 5, total - 1), "gt", 1, "red"));
  b.add((m) => tabPatchOps(m, DEFAULT_TAB, { frozen_rows: 1 }));
  b.ops.push(table(`A1:E${total - 1}`, "green"), ...widths([180, 110, 110, 110, 80]));
  return b.ops;
}

function timesheet(now = new Date()): ArtifactOp[] {
  const b = builder("Timesheet");
  // The week starting on the most recent Monday.
  const today = todaySerial(now);
  const monday = today - ((serialToDate(today).dow + 6) % 7);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const rows: string[][] = [["Day", "Date", "Start", "End", "Break", "Hours", "Project"]];
  days.forEach((d, i) => {
    const r = i + 2;
    rows.push([d, iso(monday + i), "9:00", i === 4 ? "15:30" : "17:30", "0:30", `=IF(D${r}="","",(D${r}-C${r}-E${r})*24)`, i % 2 ? "Website" : "Launch"]);
  });
  rows.push(["Total", "", "", "", "", "=SUM(OFFSET(F2,0,0,ROW()-ROW(F2)))", ""]);
  b.add((m) => gridOps(m, DEFAULT_TAB, 1, 1, rows));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(1, 1, 7, 1), { b: true }));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(1, 7, 7, 7), { b: true, bd: "t" }));
  b.add((m) => styleOps(m, DEFAULT_TAB, rect(6, 2, 6, 7), { nf: "number", dp: 2 }));
  b.add((m) => validationOps(m, DEFAULT_TAB, rect(7, 2, 7, 6), "list", [{ v: "Launch", color: "blue" }, { v: "Website", color: "violet" }, { v: "Admin", color: "gray" }]));
  b.add((m) => tabPatchOps(m, DEFAULT_TAB, { frozen_rows: 1 }));
  b.ops.push(table("A1:G6", "violet"), ...widths([70, 110, 80, 80, 80, 80, 130]));
  return b.ops;
}

export const SHEET_TEMPLATES: readonly SheetTemplate[] = [
  { id: "tracker", label: "Project tracker", ops: tracker },
  { id: "budget", label: "Budget", ops: () => budget() },
  { id: "timesheet", label: "Timesheet", ops: timesheet },
];

