import { describe, expect, test } from "bun:test";
import type { LineMetrics } from "../lineMetrics";
import { lineMetricsPhrases, windowWords } from "../lineMetricsWords";

const said = (m: LineMetrics) => lineMetricsPhrases(m).map((p) => `${p.num ?? ""}${p.text}`);

const metrics = (over: Partial<LineMetrics> = {}): LineMetrics => ({
  breaks: { breaks: 0, days: 7, perDay: 0 },
  explained: { explained: 0, opened: 0, share: null },
  holding: { held: 0, reopened: 0, share: null },
  ...over,
});

describe("lineMetricsPhrases", () => {
  test("a window with nothing to count says so, never 0%", () => {
    expect(said(metrics())).toEqual(["no expectation breaks", "no new signals yet", "no watches ended yet"]);
  });

  test("populated numbers sit inside their sentence", () => {
    expect(said(metrics({
      breaks: { breaks: 15, days: 7, perDay: 15 / 7 },
      explained: { explained: 21, opened: 4, share: 21 / 25 },
      holding: { held: 5, reopened: 1, share: 5 / 6 },
    }))).toEqual(["2.1 expectation breaks a day", "84% of new signals matched a problem already open", "5 of 6 fixes held"]);
  });

  test("singulars, a whole rate and a rare break counted over the window", () => {
    expect(said(metrics({
      breaks: { breaks: 7, days: 7, perDay: 1 },
      holding: { held: 1, reopened: 0, share: 1 },
    }))).toEqual(["1 expectation break a day", "no new signals yet", "1 of 1 fix held"]);
    expect(said(metrics({ breaks: { breaks: 1, days: 30, perDay: 1 / 30 } }))[0]).toBe("1 expectation break");
    expect(said(metrics({ breaks: { breaks: 2, days: 30, perDay: 2 / 30 } }))[0]).toBe("2 expectation breaks");
  });

  test("a line where every fix came back reads 0 of n, a real outcome", () => {
    expect(said(metrics({ holding: { held: 0, reopened: 2, share: 0 } }))[2]).toBe("0 of 2 fixes held");
    expect(said(metrics({ explained: { explained: 0, opened: 3, share: 0 } }))[1]).toBe("0% of new signals matched a problem already open");
  });
});

describe("windowWords", () => {
  test("the map's windows in full", () => {
    expect(windowWords("24h")).toBe("the last 24 hours");
    expect(windowWords("7d")).toBe("the last 7 days");
    expect(windowWords("30d")).toBe("the last 30 days");
    expect(windowWords("1d")).toBe("the last 1 day");
  });
});
