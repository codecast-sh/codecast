// `cast metrics` (external-data.md X7, X10): the watch body and what each verb posts.
import { describe, expect, test } from "bun:test";
import { SCOPE, useCliHarness } from "./externalDataCli.testHarness.js";
import { formatQueryResult, formatWatchLine, metricAddBody, type WatchRow } from "./metricsCommand.js";

describe("metricAddBody", () => {
  test("needs a source, one query and one direction", () => {
    expect(() => metricAddBody("x", { hogql: "q", above: "1" })).toThrow("--source");
    expect(() => metricAddBody("x", { source: "ph", above: "1" })).toThrow("--hogql");
    expect(() => metricAddBody("x", { source: "ph", hogql: "q", insight: "4", above: "1" })).toThrow("exactly one of --hogql");
    expect(() => metricAddBody("x", { source: "ph", hogql: "q" })).toThrow("--above");
    expect(() => metricAddBody("x", { source: "ph", hogql: "q", above: "1", below: "2" })).toThrow("--above");
    expect(() => metricAddBody("x", { source: "ph", hogql: "q", below: "lots" })).toThrow("not a number");
  });

  test("maps to the watch's wire names, with the interval in ms", () => {
    expect(metricAddBody(" Signups ", { source: "ph", insight: " 42 ", below: "10", every: "30m" })).toEqual({
      source: "ph", name: "Signups", query_kind: "insight", query: "42", threshold: 10, direction: "below", interval_ms: 1_800_000,
    });
  });
});

describe("lines", () => {
  const w: WatchRow = {
    _id: "w", short_id: "mw-2", name: "Signups", query_kind: "hogql", query: "q", threshold: 10, direction: "below",
    interval_ms: 3_600_000, status: "active", state: "alert", points: [{ at: 0, value: 20 }, { at: 1, value: 5 }], last_value: 5, last_at: 1_000, source_name: "ph",
  };
  test("a watch shows its value, its line and its state", () => {
    const line = formatWatchLine(w, 121_000);
    for (const part of ["mw-2", "Signups", "5", "(alert < 10)", "alert", "ph · 2m ago", "█▂"]) expect(line).toContain(part);
  });

  test("query rows print under their columns, and a cut is said", () => {
    expect(formatQueryResult({ columns: ["day", "n"], results: [["2026-10-01", 4], ["2026-10-02", null]], rows: 3, truncated: true })).toContain("day\tn\n2026-10-01\t4\n2026-10-02\t\n");
  });
});

describe("cast metrics on the wire", () => {
  const h = useCliHarness("metrics", async () => (await import("./metricsCommand.js")).registerMetricsCommand);

  test("add and query carry the scope; show and rm post the ref", async () => {
    h.answer = (p) => (p === "/cli/metrics/query" ? { columns: ["n"], results: [[1]], rows: 1, truncated: false } : p === "/cli/metrics/remove" ? { removed: "mw-1" } : p === "/cli/metrics/get" ? { watch: { short_id: "mw-1", name: "n", query_kind: "hogql", query: "q", threshold: 1, direction: "above", interval_ms: 7_200_000, status: "active", points: [], last_value: null, last_at: null, source_name: "ph" }, group: null } : { watch: { short_id: "mw-1", name: "n", threshold: 1, direction: "above", points: [], last_value: null, last_at: null, source_name: "ph" } });
    await h.run("add", "Errors", "--source", "ph", "--hogql", "select count() from events", "--above", "100");
    await h.run("query", "select 1", "--source", "ph");
    await h.run("show", "mw-1");
    await h.run("rm", "mw-1");
    expect(h.calls).toEqual([
      { path: "/cli/metrics/create", body: { source: "ph", name: "Errors", query_kind: "hogql", query: "select count() from events", threshold: 100, direction: "above", ...SCOPE } },
      { path: "/cli/metrics/query", body: { source: "ph", query: "select 1", ...SCOPE } },
      { path: "/cli/metrics/get", body: { watch: "mw-1" } },
      { path: "/cli/metrics/remove", body: { watch: "mw-1" } },
    ]);
    // show prints the interval in the shared duration grammar, not as minutes.
    expect(h.out()).toContain("every 2h");
  });

  test("query without --source posts nothing", async () => {
    await expect(h.run("query", "select 1")).rejects.toThrow(/exit 1/);
    expect(h.calls).toHaveLength(0);
  });
});
