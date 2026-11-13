import { describe, expect, test } from "bun:test";
import { FUNCTIONS } from "./functions";
import { FUNCTION_DOCS, argIndexFor, callAt, errorFix, fnSignature, nearestFunction, ERROR_DOCS } from "./catalog";
import { ERROR_CODES } from "./formula";

describe("function catalog", () => {
  test("documents every engine function with the engine's argument counts", () => {
    expect(Object.keys(FUNCTION_DOCS).sort()).toEqual(Object.keys(FUNCTIONS).sort());
    for (const [name, def] of Object.entries(FUNCTIONS)) {
      const args = FUNCTION_DOCS[name].args;
      const repeats = args.some((a) => a.endsWith("..."));
      const required = args.filter((a) => !a.endsWith("?") && !a.endsWith("...")).length;
      expect([name, required]).toEqual([name, def.min]);
      expect([name, repeats ? undefined : args.length]).toEqual([name, def.max]);
    }
  });

  test("every error code has a card", () => {
    for (const code of ERROR_CODES) expect(ERROR_DOCS[code]?.title).toBeTruthy();
  });

  test("signature reads like Sheets", () => {
    expect(fnSignature("ROUND")).toBe("ROUND(value, [places])");
    expect(fnSignature("SUM")).toBe("SUM(value1, value2, …)");
  });

  test("callAt follows the caret through nesting, strings and tab names", () => {
    expect(callAt("=ROUND(SUM(A1:A4), ", 19)).toEqual({ name: "ROUND", arg: 1 });
    expect(callAt("=ROUND(SUM(A1,", 14)).toEqual({ name: "SUM", arg: 1 });
    expect(callAt('=IF(A1=",", ', 12)).toEqual({ name: "IF", arg: 1 });
    expect(callAt("=SUM('a,b'!A1, ", 15)).toEqual({ name: "SUM", arg: 1 });
    expect(callAt("=SUM(A1)+", 9)).toBeNull();
    expect(callAt("=(A1+", 5)).toBeNull();
    expect(callAt("plain, text", 6)).toBeNull();
  });

  test("argIndexFor wraps repeating tails", () => {
    expect(argIndexFor("SUM", 5)).toBe(1);
    expect(argIndexFor("ROUND", 4)).toBe(-1);
    // SUMIFS(sum_range, criteria_range1, criterion1, more...): arg 3 is the next range, 4 its criterion.
    expect(argIndexFor("SUMIFS", 3)).toBe(1);
    expect(argIndexFor("SUMIFS", 4)).toBe(2);
    expect(argIndexFor("IFS", 2)).toBe(0);
  });

  test("nearestFunction suggests close spellings only", () => {
    const names = Object.keys(FUNCTIONS);
    expect(nearestFunction("SUMM", names)).toBe("SUM");
    expect(nearestFunction("VLOKUP", names)).toBe("VLOOKUP");
    expect(nearestFunction("BANANAS", names)).toBeNull();
  });
});

describe("errorFix", () => {
  test("offers the closest function for a typo", () => {
    expect(errorFix("#NAME?", "unknown function SUMM", "=SUMM(A1:A4)/2")).toEqual({ label: "Use SUM", text: "=SUM(A1:A4)/2" });
    expect(errorFix("#NAME?", "unknown function BANANA", "=BANANA(1)")).toBeNull();
  });
  test("wraps division and lookup errors once", () => {
    expect(errorFix("#DIV/0!", "division by zero", "=A1/B1")?.text).toBe("=IFERROR(A1/B1, 0)");
    expect(errorFix("#DIV/0!", undefined, "=IFERROR(A1/B1)")).toBeNull();
    expect(errorFix("#N/A", undefined, "=VLOOKUP(A2,B:C,2,FALSE)")?.text).toBe('=IFNA(VLOOKUP(A2,B:C,2,FALSE), "")');
    expect(errorFix("#N/A", undefined, "#N/A")).toBeNull();
  });
});

import { functionMatches } from "./catalog";
import { FUNCTION_NAMES } from "./functions";
describe("functionMatches", () => {
  test("common functions come first", () => {
    expect(functionMatches("SU", FUNCTION_NAMES)[0]).toBe("SUM");
    expect(functionMatches("CO", FUNCTION_NAMES).slice(0, 3)).toEqual(["COUNT", "COUNTIF", "COUNTA"]);
    expect(functionMatches("VL", FUNCTION_NAMES)).toEqual(["VLOOKUP"]);
  });
});

import { ARG_HELP, argHelp } from "./catalog";
describe("argument help", () => {
  test("every help entry names a real argument, and lookups strip the optional mark", () => {
    for (const [fn, args] of Object.entries(ARG_HELP)) for (const a of Object.keys(args)) expect([fn, FUNCTION_DOCS[fn].args.map((x) => x.replace(/[?.]+$/, "")).includes(a)]).toEqual([fn, true]);
    expect(argHelp("ROUND", 1)).toContain("Decimal places");
    expect(argHelp("SUM", 0)).toBeUndefined();
  });
});

describe("dates typed without a year", () => {
  test("take the current year; other text is left alone", async () => {
    const { completeDateInput } = await import("./values");
    const now = new Date(2026, 10, 11);
    expect(["Nov 5", "5 November", "11/5", "Feb 30", "Novel 5", "5"].map((t) => completeDateInput(t, now))).toEqual(["2026-11-05", "2026-11-05", "2026-11-05", "Feb 30", "Novel 5", "5"]);
  });
});

describe("elapsed time codes", () => {
  test("[h]:mm keeps counting past a day; [mm] counts minutes", async () => {
    const { formatValue } = await import("./format");
    expect(formatValue(29.75 / 24, { nf: "custom", code: "[h]:mm" })).toBe("29:45");
    expect(formatValue(1.5 / 24, { nf: "custom", code: "[mm]:ss" })).toBe("90:00");
  });
});

describe("lookup results read like their column", () => {
  test("VLOOKUP and INDEX into a currency column show currency, as XLOOKUP does", async () => {
    const { sheetSpec } = await import("../sheet");
    const { doc } = await import("./sheetDoc.testkit");
    const { buildModel, inheritedFormat } = await import("./model");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "Name\tAmount\nAna\t$800\nBo\t$3,400.50");
    const m = buildModel(d.elements());
    for (const f of ['=VLOOKUP("Ana",A1:B3,2,FALSE)', "=INDEX(A1:B3,2,2)", '=XLOOKUP("Bo",A1:A3,B1:B3)']) expect([f, inheritedFormat(m, "Sheet1", f)?.nf]).toEqual([f, "currency"]);
  });
});

describe("agent range reads", () => {
  test("cast sheet range gives dates as they show", async () => {
    const { sheetSpec } = await import("../sheet");
    const { doc } = await import("./sheetDoc.testkit");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "Due\tQty\n2026-11-28\t5\n=A2+1\t");
    expect(d.verb("range", ["A1:B3"]).status).toBe("Due\tQty\n2026-11-28\t5\n2026-11-29\t");
  });
});

describe("array results read like their source", () => {
  test("FILTER and SORT blocks show each source column's format", async () => {
    const { sheetSpec } = await import("../sheet");
    const { doc } = await import("./sheetDoc.testkit");
    const { buildModel, workbookFor, displayFormat } = await import("./model");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "Name\tAmount\tShare\nAna\t$800\t10%\nBo\t$3,400.50\t25%");
    d.verb("write", ["E1"], '=FILTER(A2:C3,B2:B3>0)\t\t\t=SORT(B2:B3)\t=SORT(FILTER(B2:C3,C2:C3>0),1,TRUE)');
    const m = buildModel(d.elements());
    const wb = workbookFor(m);
    expect([displayFormat(m, wb, "Sheet1", 5, 1)?.nf, displayFormat(m, wb, "Sheet1", 6, 2)?.nf, displayFormat(m, wb, "Sheet1", 7, 1)?.nf, displayFormat(m, wb, "Sheet1", 8, 2)?.nf, displayFormat(m, wb, "Sheet1", 9, 2)?.nf, displayFormat(m, wb, "Sheet1", 10, 1)?.nf]).toEqual([undefined, "currency", "percent", "currency", "currency", "percent"]);
  });
});

describe("reading a spill past the typed cells", () => {
  test("cast sheet range includes the whole spilled block", async () => {
    const { sheetSpec } = await import("../sheet");
    const { doc } = await import("./sheetDoc.testkit");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "b\nc\na");
    d.verb("write", ["C3"], "=SORT(A1:A3)");
    expect(d.verb("range", ["C3:C6"]).status).toBe("a\nb\nc");
  });
});
