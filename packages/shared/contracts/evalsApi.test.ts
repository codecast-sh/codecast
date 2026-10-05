import { describe, expect, test } from "bun:test";
import { EVALS_ROUTE_KEYS, EVALS_SHA_RE, matchEvalsRoute, runRowProblems, searchRows, type RunRow } from "./evalsApi";

const row: RunRow = {
  id: "settle-1a2b3c4d-seed1-2026-10-03T01-13-08-164Z",
  surface: "settle",
  freezeId: "1a2b3c4d5e6f",
  freezeName: "a moment",
  visibility: "private",
  seed: 1,
  stamp: "2026-10-03T01:13:08.164Z",
  batch: "nightly-2026-10-03",
  batchAt: "2026-10-03T01:13:08.164Z",
  cadence: "nightly",
  status: "pass",
  score: 0.9,
  passMark: 0.7,
  gatesFailed: [],
  checks: { criteria: 0.9 },
  missedFloors: [],
  model: "claude-sonnet",
  judgeModel: "claude-opus",
  ruler: "r1",
  gitHead: "907fc8c7e",
  mainSha: "907fc8c7e",
  dirty: false,
  offBranch: false,
  treePatch: null,
  sourceHash: "aa",
  sourceHashDisk: "aa",
  promptSha: "bb",
  freezeSha: null,
  liveReads: 0,
  costUsd: 0.01,
  judgeCostUsd: 0.002,
  realMs: 1200,
  guard: { served: 0, unserved: 0, live: 0, refused: 0, unknown: 0, help: 0 },
  scoreVersions: 1,
};

describe("runRowProblems", () => {
  test("a whole row has none", () => {
    expect(runRowProblems(row)).toEqual([]);
  });

  test("names each missing or mistyped field", () => {
    const { treePatch: _, ...missing } = row;
    expect(runRowProblems(missing)).toEqual(["treePatch: missing"]);
    expect(runRowProblems({ ...row, seed: "1" })).toEqual(['seed: expected number, got "1"']);
    expect(runRowProblems({ ...row, guard: { served: 1 } })[0]).toStartWith("guard:");
    expect(runRowProblems({ ...row, checks: { criteria: "x" } })[0]).toStartWith("checks:");
  });

  test("refuses an unknown status or visibility", () => {
    expect(runRowProblems({ ...row, status: "running" })).toEqual(['status: unknown "running"']);
    expect(runRowProblems({ ...row, visibility: "team" })).toEqual(['visibility: unknown "team"']);
  });

  test("a non-object is not a row", () => {
    expect(runRowProblems(null)).toEqual(["not an object"]);
    expect(runRowProblems([row])).toEqual(["not an object"]);
  });
});

describe("searchRows", () => {
  const row = (id: string, freezeId: string, stamp: string) => ({ id, surface: "settle", freezeId, freezeName: `f ${freezeId}`, batch: "b", stamp });
  const rows = [row("settle-54f84f69-seed1-2026-10-01T00-00-00-000Z", "54f84f69aa", "2026-10-01T00:00:00.000Z"), row("settle-54f84f69-seed2-2026-10-02T00-00-00-000Z", "54f84f69aa", "2026-10-02T00:00:00.000Z"), row("settle-ca497977-seed1-2026-10-03T00-00-00-000Z", "ca497977bb", "2026-10-03T00:00:00.000Z")];
  test("matches a freeze id prefix once and runs by prefix, newest first", () => {
    expect(searchRows(rows, "54f8").freezes).toEqual([{ id: "54f84f69aa", name: "f 54f84f69aa", surface: "settle" }]);
    expect(searchRows(rows, "settle-54f").runs.map((r) => r.id)).toEqual([rows[1]!.id, rows[0]!.id]);
  });
  test("asks for three characters before it matches anything", () => {
    expect(searchRows(rows, "se")).toEqual({ freezes: [], runs: [] });
  });
});

describe("matchEvalsRoute", () => {
  test("every key in the spec's table is listed once", () => {
    expect(EVALS_ROUTE_KEYS.length).toBe(24);
    expect(new Set(EVALS_ROUTE_KEYS).size).toBe(EVALS_ROUTE_KEYS.length);
  });

  test("each route matches its own pattern", () => {
    for (const key of EVALS_ROUTE_KEYS) {
      const [method, pattern] = key.split(" ") as [string, string];
      const path = pattern.replace(/:(\w+)/g, (_, name: string) => `x-${name}`);
      expect(matchEvalsRoute(method, path)?.key).toBe(key);
    }
  });

  test("decodes params and tells static paths from param paths", () => {
    expect(matchEvalsRoute("GET", "/sim/run/2026-10-03T01/memberRemovedMidTurn-interleave-3")).toEqual({
      key: "GET /sim/run/:session/:run",
      params: { session: "2026-10-03T01", run: "memberRemovedMidTurn-interleave-3" },
    });
    expect(matchEvalsRoute("POST", "/bisect/plan")?.key).toBe("POST /bisect/plan");
    expect(matchEvalsRoute("POST", "/bisect/b-12/stop")).toEqual({ key: "POST /bisect/:id/stop", params: { id: "b-12" } });
    expect(matchEvalsRoute("GET", "/run/a%2Fb/file")).toEqual({ key: "GET /run/:id/file", params: { id: "a/b" } });
    expect(matchEvalsRoute("get", "/health")?.key).toBe("GET /health");
  });

  test("refuses the wrong method, unknown paths and bad encodings", () => {
    expect(matchEvalsRoute("POST", "/overview")).toBeNull();
    expect(matchEvalsRoute("GET", "/runs")).toBeNull();
    expect(matchEvalsRoute("GET", "/run//file")).toBeNull();
    expect(matchEvalsRoute("GET", "/run/%E0%A4%A/file")).toBeNull();
  });
});

test("EVALS_SHA_RE takes 7 to 40 lowercase hex", () => {
  expect(EVALS_SHA_RE.test("907fc8c")).toBe(true);
  expect(EVALS_SHA_RE.test("907fc8")).toBe(false);
  expect(EVALS_SHA_RE.test("907FC8C7E")).toBe(false);
  expect(EVALS_SHA_RE.test("HEAD")).toBe(false);
});
