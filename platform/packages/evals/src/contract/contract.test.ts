import { describe, expect, test } from "bun:test";

import { EVALS_SHA_RE, EVALS_VIEW_ROUTE_KEYS, evalsBatchRef, flipCounts, isNoiseFlip, matchRoute, resolveEvalsBatchRef, rowProblems, RUN_ROW_CORE_FIELDS, runRowCoreProblems, unaskedSet, type RunRowCore, type VerdictFlip } from ".";

// The contract's helpers, moved from codecast's shared/contracts/evalsApi.test.ts
// with their cases as they were. A product row and a product route table stand
// in for codecast's own: the row is the core plus codecast's fields, checked
// through rowProblems with its own field map, and the table is the neutral
// keys plus codecast's extras, matched through matchRoute, so the cases also
// prove a product composes both the way codecast does.

type RunRow = RunRowCore & { sourceHash: string | null; guard: Record<"served" | "unserved" | "live" | "refused" | "unknown" | "help", number>; scoreVersions: number };
const isGuard = (v: unknown) => !!v && typeof v === "object" && ["served", "unserved", "live", "refused", "unknown", "help"].every((k) => typeof (v as Record<string, unknown>)[k] === "number");
const runRowProblems = (value: unknown) => rowProblems(value, { ...RUN_ROW_CORE_FIELDS, sourceHash: "string?", guard: { name: "guard", ok: isGuard }, scoreVersions: "number" });

/** Codecast's table: the neutral routes, then its own. */
const EVALS_ROUTE_KEYS = [
  ...EVALS_VIEW_ROUTE_KEYS,
  "GET /run/:id/file",
  "GET /patch/:sha",
  "GET /search",
  "POST /bisect/plan",
  "POST /bisect",
  "POST /bisect/:id/stop",
  "GET /sim/catalog",
  "GET /sim/sessions",
  "GET /sim/run/:session/:run",
  "POST /sim/shrink",
  "POST /sim/sweep",
] as const;
const matchEvalsRoute = (method: string, path: string) => matchRoute(EVALS_ROUTE_KEYS, method, path);

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

describe("matchEvalsRoute", () => {
  test("every key in the spec's table is listed once", () => {
    expect(EVALS_VIEW_ROUTE_KEYS.length).toBe(13);
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

describe("flip noise", () => {
  const flip = (direction: VerdictFlip["direction"], extra: Partial<VerdictFlip> = {}): VerdictFlip => ({ freezeId: "f", name: "a moment", visibility: "public", direction, before: ["a"], after: ["b"], ...extra });

  test("a flip on a freeze that flaps 9 times in 22 batches, under the same prompt, is noise and never counts as broke", () => {
    // The title row of 2026-10-04: jx7btyt:100 flipped in 9 of 22 batches and rendered one promptSha on every night.
    const flapping = flip("broke", { history: { flips: 9, batches: 22 }, samePrompt: true });
    const real = flip("broke", { history: { flips: 1, batches: 22 }, samePrompt: false });
    expect(isNoiseFlip(flapping)).toBe(true);
    expect(isNoiseFlip(real)).toBe(false);
    const c = flipCounts([flapping, real, flip("fixed", { history: { flips: 2, batches: 22 } })]);
    expect(c.broke).toBe(1);
    expect(c.fixed).toBe(1);
    expect(c.noise).toEqual([flapping]);
  });

  test("an unchanged prompt alone makes a flip noise, and a flip with no history is taken at its word", () => {
    expect(isNoiseFlip(flip("broke", { history: { flips: 1, batches: 22 }, samePrompt: true }))).toBe(true);
    expect(flipCounts([flip("broke")])).toEqual({ broke: 1, fixed: 0, noise: [] });
  });
});

describe("unaskedSet", () => {
  test("every rep failed and nothing was spent on the model or the judge: the harness answered, not the prompt", () => {
    // The ~line-branch batches of 2026-10-02: a reply of "..." in 3 ms, $0, every rep failing its clean gate.
    expect(unaskedSet([{ status: "fail", costUsd: 0, judgeCostUsd: 0 }, { status: "fail", costUsd: 0 }, { status: "crash", costUsd: 0 }])).toBe(true);
  });

  test("a prompt that breaks parsing still pays for its calls, a passing rep is an answer, and an all-crash set is a crash", () => {
    expect(unaskedSet([{ status: "fail", costUsd: 0.002, judgeCostUsd: 0 }])).toBe(false);
    expect(unaskedSet([{ status: "fail", costUsd: 0 }, { status: "pass", costUsd: 0 }])).toBe(false);
    expect(unaskedSet([{ status: "crash", costUsd: 0 }])).toBe(false);
    expect(unaskedSet([])).toBe(false);
  });
});


describe("a row without a product's fields", () => {
  test("the core alone validates against RUN_ROW_CORE_FIELDS, and a product's extra rules come after the field lines", () => {
    const { sourceHash: _a, guard: _b, scoreVersions: _c, ...core } = row;
    expect(runRowCoreProblems(core)).toEqual([]);
    const { liveReads: _d, ...short } = core;
    expect(runRowCoreProblems(short)).toEqual(["liveReads: missing"]);
    expect(rowProblems({ ...core, seed: "1" }, RUN_ROW_CORE_FIELDS, () => ["extra: product rule"])).toEqual(['seed: expected number, got "1"', "extra: product rule"]);
  });
});

describe("evalsBatchRef", () => {
  test("a stamp, a sha or a token stands as itself; a chosen name travels as its hash and resolves back among known names", () => {
    expect(evalsBatchRef("2026-10-03T01:13:08.164Z")).toBe("2026-10-03T01:13:08.164Z");
    expect(evalsBatchRef("907fc8c7e")).toBe("907fc8c7e");
    const ref = evalsBatchRef("nightly-2026-10-03");
    expect(ref).toMatch(/^_[0-9a-f]{8}$/);
    expect(evalsBatchRef(ref)).toBe(ref);
    expect(evalsBatchRef(null)).toBeNull();
    expect(resolveEvalsBatchRef(ref, ["other", "nightly-2026-10-03"])).toBe("nightly-2026-10-03");
    expect(resolveEvalsBatchRef(ref, ["other"])).toBeNull();
    expect(resolveEvalsBatchRef("plain", [])).toBe("plain");
  });
});
