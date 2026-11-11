import { describe, expect, test } from "bun:test";
import { Workbook } from "./engine";
import { parseFormula, tokenize } from "./formula";
import { parseLiteral, dateToSerial } from "./values";
import { formatValue, formatWithCode } from "./format";
import { parseA1 } from "./refs";

function book(cells: Record<string, string>, tabs = [{ id: "Sheet1", name: "Sheet1" }]) {
  const wb = new Workbook({ now: () => new Date(2026, 10, 10, 9, 30) });
  wb.setTabs(tabs);
  wb.update(
    Object.entries(cells).map(([ref, input]) => {
      const [tab, a] = ref.includes("!") ? ref.split("!") : ["Sheet1", ref];
      const p = parseA1(a)!;
      return { tab, col: p.col, row: p.row, input };
    }),
  );
  const v = (ref: string) => {
    const [tab, a] = ref.includes("!") ? ref.split("!") : ["Sheet1", ref];
    const p = parseA1(a)!;
    return wb.value(tab, p.col, p.row);
  };
  return { wb, v };
}

describe("parser", () => {
  test("precedence and refs", () => {
    expect(parseFormula("1+2*3^2")).toEqual({
      t: "bin",
      op: "+",
      a: { t: "num", v: 1 },
      b: { t: "bin", op: "*", a: { t: "num", v: 2 }, b: { t: "bin", op: "^", a: { t: "num", v: 3 }, b: { t: "num", v: 2 } } },
    });
    expect(parseFormula("'Q4 plan'!$A$1:B9")).toEqual({ t: "range", tab: "Q4 plan", c0: 1, r0: 1, c1: 2, r1: 9 });
    expect(parseFormula("Historical!B2")).toEqual({ t: "ref", tab: "Historical", col: 2, row: 2 });
    expect(parseFormula("SUM(A:A)")).toMatchObject({ t: "fn", name: "SUM", args: [{ t: "range", c0: 1, c1: 1, r0: 1 }] });
    expect(parseFormula("log10(100)")).toMatchObject({ t: "fn", name: "LOG10" });
  });
  test("token positions let references be rewritten", () => {
    const src = "SUM(B2:B5)*$C$1";
    const refs = tokenize(src).filter((t) => t.type === "ref");
    expect(refs.map((r) => src.slice(r.start, r.end))).toEqual(["B2:B5", "$C$1"]);
  });
  test("syntax errors surface as #ERROR!", () => {
    const { v } = book({ A1: "=SUM(1,", A2: "=1+" });
    expect(v("A1")).toMatchObject({ error: "#ERROR!" });
    expect(v("A2")).toMatchObject({ error: "#ERROR!" });
  });
});

describe("literals", () => {
  test("numbers, percents, currency, dates", () => {
    expect(parseLiteral("21,000")).toEqual({ value: 21000, implied: { nf: "number", dp: 0 } });
    expect(parseLiteral("+10%")).toEqual({ value: 0.1, implied: { nf: "percent", dp: 0 } });
    expect(parseLiteral("$1,200.50").value).toBe(1200.5);
    expect(parseLiteral("2026-11-10")).toEqual({ value: dateToSerial(2026, 11, 10), implied: { nf: "date" } });
    expect(parseLiteral("'0042").value).toBe("0042");
    expect(parseLiteral("Website").value).toBe("Website");
    expect(parseLiteral("TRUE").value).toBe(true);
  });
});

describe("evaluation", () => {
  test("the pre-orders forecast", () => {
    const { v } = book({
      A2: "Website", B2: "21000", C2: "10%", D2: "=B2*(1+C2)",
      A3: "Email list", B3: "14000", C3: "5%", D3: "=B3*(1+C3)",
      B6: "=SUM(B2:B5)", D6: "=SUM(D2:D5)", C6: "=D6/B6-1",
    });
    expect(v("D2")).toBeCloseTo(23100);
    expect(v("B6")).toBe(35000);
    expect(v("D6")).toBeCloseTo(37800);
    expect(v("C6")).toBeCloseTo(0.08);
  });

  test("recalculates downstream of an edit, through ranges", () => {
    const { wb, v } = book({ A1: "1", A2: "2", A3: "=SUM(A1:A2)", A4: "=A3*10" });
    expect(v("A4")).toBe(30);
    wb.setCell("Sheet1", 1, 1, "5");
    expect(v("A4")).toBe(70);
    wb.setCell("Sheet1", 1, 2, "");
    expect(v("A3")).toBe(5);
  });

  test("circular references are #CIRC! and recover when broken", () => {
    const { wb, v } = book({ A1: "=B1+1", B1: "=A1+1", C1: "=A1*2" });
    expect(v("A1")).toMatchObject({ error: "#CIRC!" });
    expect(v("C1")).toMatchObject({ error: "#CIRC!" });
    wb.setCell("Sheet1", 2, 1, "4");
    expect(v("A1")).toBe(5);
    expect(v("C1")).toBe(10);
  });

  test("self reference through a range is circular", () => {
    const { v } = book({ A1: "1", A2: "=SUM(A1:A3)" });
    expect(v("A2")).toMatchObject({ error: "#CIRC!" });
  });

  test("a 10k-row chain does not overflow the stack", () => {
    const cells: Record<string, string> = { A1: "1" };
    for (let r = 2; r <= 10_000; r++) cells[`A${r}`] = `=A${r - 1}+1`;
    const { v } = book(cells);
    expect(v("A10000")).toBe(10000);
  });

  test("cross-tab references by name, and rename", () => {
    const tabs = [
      { id: "Sheet1", name: "Forecast" },
      { id: "t2", name: "Historical" },
    ];
    const { wb, v } = book({ "t2!B2": "100", "t2!B3": "50", A1: "=SUM(Historical!B2:B3)", A2: "='Missing tab'!A1" }, tabs);
    expect(v("A1")).toBe(150);
    expect(v("A2")).toMatchObject({ error: "#REF!" });
    wb.setCell("t2", 2, 3, "70");
    expect(v("A1")).toBe(170);
    wb.setTabs([{ id: "Sheet1", name: "Forecast" }, { id: "t2", name: "Old" }]);
    expect(v("A1")).toMatchObject({ error: "#REF!" });
  });

  test("errors", () => {
    const { v } = book({ A1: "=1/0", A2: "=A1+1", A3: "=IFERROR(A1,0)", A4: "=FOO(1)", A5: '="a"+1', A6: "=nope" });
    expect(v("A1")).toMatchObject({ error: "#DIV/0!" });
    expect(v("A2")).toMatchObject({ error: "#DIV/0!" });
    expect(v("A3")).toBe(0);
    expect(v("A4")).toMatchObject({ error: "#NAME?" });
    expect(v("A5")).toMatchObject({ error: "#VALUE!" });
    expect(v("A6")).toMatchObject({ error: "#NAME?" });
  });

  test("aggregates and conditionals", () => {
    const { v } = book({
      A1: "Website", B1: "10",
      A2: "Email", B2: "20",
      A3: "Website", B3: "30",
      A4: "Gift", B4: "text",
      C1: "=SUM(B1:B4)", C2: "=AVERAGE(B1:B3)", C3: "=MIN(B1:B4)", C4: "=MAX(B1:B4)",
      C5: "=COUNT(B1:B4)", C6: '=SUMIF(A1:A4,"Website",B1:B4)', C7: '=COUNTIF(B1:B4,">15")',
      C8: '=IF(C1>50,"big","small")', C9: "=ROUND(2.345,2)", C10: '=SUMIFS(B1:B4,A1:A4,"W*",B1:B4,">15")',
      C11: "=COUNTA(A1:B4)", C12: '=AVERAGEIF(A1:A4,"<>Email",B1:B4)',
    });
    expect(v("C1")).toBe(60);
    expect(v("C2")).toBe(20);
    expect(v("C3")).toBe(10);
    expect(v("C4")).toBe(30);
    expect(v("C5")).toBe(3);
    expect(v("C6")).toBe(40);
    expect(v("C7")).toBe(2);
    expect(v("C8")).toBe("big");
    expect(v("C9")).toBe(2.35);
    expect(v("C10")).toBe(30);
    expect(v("C11")).toBe(8);
    expect(v("C12")).toBe(20);
  });

  test("lookups", () => {
    const { v } = book({
      A1: "Apple", B1: "3", C1: "red",
      A2: "Banana", B2: "5", C2: "yellow",
      A3: "Cherry", B3: "7", C3: "dark red",
      E1: '=XLOOKUP("Banana",A1:A3,C1:C3)',
      E2: '=XLOOKUP("Kiwi",A1:A3,C1:C3,"none")',
      E3: '=VLOOKUP("Cherry",A1:C3,3,FALSE)',
      E4: "=VLOOKUP(6,B1:C3,2)",
      E5: '=INDEX(A1:C3,MATCH("Banana",A1:A3,0),2)',
      E6: '=XLOOKUP("Kiwi",A1:A3,B1:B3)',
      E7: "=XLOOKUP(6,B1:B3,A1:A3,,-1)",
    });
    expect(v("E1")).toBe("yellow");
    expect(v("E2")).toBe("none");
    expect(v("E3")).toBe("dark red");
    expect(v("E4")).toBe("yellow");
    expect(v("E5")).toBe(5);
    expect(v("E6")).toMatchObject({ error: "#N/A" });
    expect(v("E7")).toBe("Banana");
  });

  test("text and dates", () => {
    const { v } = book({
      A1: " pre  orders ",
      B1: "=PROPER(TRIM(A1))",
      B2: '=LEFT("Website",3)&"-"&RIGHT("Website",4)',
      B3: '=SUBSTITUTE("a-b-c","-","+")',
      B4: '=TEXT(0.256,"0.0%")',
      B5: '=TEXT(1234.5,"$#,##0.00")',
      B6: "=DATE(2026,11,10)",
      B7: "=YEAR(B6)*100+MONTH(B6)",
      B8: '=TEXT(B6,"mmm d, yyyy")',
      B9: "=EOMONTH(B6,1)-B6",
      B10: '=DATEDIF("2026-01-15","2026-11-10","M")',
      B11: "=TODAY()",
      B12: '=LEN("pies")',
      B13: '=TEXTJOIN(", ",TRUE,A2:A4,"x","y")',
      B14: '=FIND("b","abc")',
      B15: "=WEEKDAY(B6)",
    });
    expect(v("B1")).toBe("Pre Orders");
    expect(v("B2")).toBe("Web-site");
    expect(v("B3")).toBe("a+b+c");
    expect(v("B4")).toBe("25.6%");
    expect(v("B5")).toBe("$1,234.50");
    expect(v("B6")).toBe(dateToSerial(2026, 11, 10));
    expect(v("B7")).toBe(202611);
    expect(v("B8")).toBe("Nov 10, 2026");
    expect(v("B9")).toBe(51);
    expect(v("B10")).toBe(9);
    expect(v("B11")).toBe(dateToSerial(2026, 11, 10));
    expect(v("B12")).toBe(4);
    expect(v("B13")).toBe("x, y");
    expect(v("B14")).toBe(2);
    expect(v("B15")).toBe(3);
  });

  test("comparison and concatenation", () => {
    const { v } = book({ A1: "5", B1: '=A1>3', B2: '="x"&A1', B3: '=A1="5"', B4: "=A2=0", B5: '="abc"<"abd"' });
    expect(v("B1")).toBe(true);
    expect(v("B2")).toBe("x5");
    expect(v("B3")).toBe(false);
    expect(v("B4")).toBe(true);
    expect(v("B5")).toBe(true);
  });
});

describe("display formats", () => {
  test("cell formats", () => {
    expect(formatValue(21000, { nf: "number" })).toBe("21,000");
    expect(formatValue(0.1, { nf: "percent", sign: true })).toBe("+10%");
    expect(formatValue(0.068, { nf: "percent", dp: 1, sign: true })).toBe("+6.8%");
    expect(formatValue(-1234.5, { nf: "currency" })).toBe("-$1,234.50");
    expect(formatValue(4213, { nf: "number", sign: true })).toBe("+4,213");
    expect(formatValue(3.6666, { dp: 1 })).toBe("3.7");
    expect(formatValue(dateToSerial(2026, 11, 10), { nf: "date" })).toBe("2026-11-10");
    expect(formatValue(0.1, undefined, { nf: "percent", dp: 0 })).toBe("10%");
    expect(formatValue(1 / 3, undefined)).toBe("0.333333333333");
    expect(formatValue({ error: "#N/A" }, undefined)).toBe("#N/A");
  });
  test("TEXT codes", () => {
    expect(formatWithCode(1234.567, "#,##0")).toBe("1,235");
    expect(formatWithCode(0.5, "0%")).toBe("50%");
    expect(formatWithCode(3.1, "0.0#")).toBe("3.1");
    expect(formatWithCode(dateToSerial(2026, 1, 5), "yyyy-mm-dd")).toBe("2026-01-05");
    expect(formatWithCode(dateToSerial(2026, 1, 5), "dddd")).toBe("Monday");
  });
});

describe("review fixes", () => {
  test("coordinates past the grid are not references and never alias another tab", () => {
    const tabs = [{ id: "A", name: "A" }, { id: "B", name: "B" }];
    const { wb, v } = book({ "B!A1": "7" }, tabs);
    wb.setCell("A", 1, 1_048_577, "99");
    expect(v("B!A1")).toBe(7);
    expect(parseA1("A1048577")).toBeNull();
    const { v: v2 } = book({ A1: "=A1048577" });
    expect(v2("A1")).toMatchObject({ error: "#NAME?" });
  });
  test("ROW and COLUMN of their own cell are not circular", () => {
    const { v } = book({ A1: "=ROW(A1)", B3: "=COLUMN(B3)*10", C1: "=ROWS(C1:C5)" });
    expect(v("A1")).toBe(1);
    expect(v("B3")).toBe(20);
    expect(v("C1")).toBe(5);
  });
  test("a 10k-row running-sum chain invalidates fast", () => {
    const cells: Record<string, string> = { A1: "1" };
    for (let r = 2; r <= 10_000; r++) cells[`A${r}`] = `=SUM(A1:A${r - 1})+1`;
    const { wb, v } = book(cells);
    expect(v("A20")).toBe(2 ** 19);
    const t = performance.now();
    wb.setCell("Sheet1", 1, 1, "2");
    expect(performance.now() - t).toBeLessThan(1500);
    expect(v("A3")).toBe(6);
  });
  test("TODAY recalculates when the clock moves", () => {
    let now = new Date(2026, 10, 10);
    const wb = new Workbook({ now: () => now });
    wb.setTabs([{ id: "Sheet1", name: "Sheet1" }]);
    wb.update([{ tab: "Sheet1", col: 1, row: 1, input: "=TODAY()" }, { tab: "Sheet1", col: 1, row: 2, input: "=A1+1" }]);
    expect(wb.value("Sheet1", 1, 2)).toBe(dateToSerial(2026, 11, 11));
    now = new Date(2026, 10, 11);
    expect(wb.refreshVolatile()).toBe(true);
    expect(wb.value("Sheet1", 1, 2)).toBe(dateToSerial(2026, 11, 12));
  });
});

describe("checkbox format", () => {
  test("TRUE/1 tick, anything else is an empty box", () => {
    expect(formatValue(true, { nf: "check" })).toBe("☑");
    expect(formatValue(1, { nf: "check" })).toBe("☑");
    expect(formatValue(false, { nf: "check" })).toBe("☐");
    expect(formatValue(null, { nf: "check" })).toBe("☐");
  });
});
