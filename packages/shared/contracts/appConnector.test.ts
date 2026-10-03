import { describe, expect, test } from "bun:test";
import {
  activeGrant,
  buildAppRequest,
  canonicalJson,
  coerceArgs,
  doRefusal,
  formatActorHeader,
  grantPagePath,
  grantableActions,
  isSafeAppPath,
  mapWatchRows,
  parseAppManifest,
  sentryStatusAction,
  sourceHasGrants,
  validateJson,
  withGrant,
  writeRefusal,
  VENDOR_ACTIONS,
  type AppWatch,
  type JsonSchema,
} from "./appConnector";
import { validateIngestBatch } from "./ingest";

const manifest = {
  name: "Union",
  version: "3",
  readers: [
    { name: "history.timeline", title: "Timeline", method: "GET", path: "/codecast/history/{contact_id}", input: { type: "object", properties: { contact_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["contact_id"] } },
    { name: "invariants.list", method: "GET", path: "/codecast/invariants" },
    { name: "jobs.failed", method: "GET", path: "/codecast/jobs/failed" },
  ],
  actions: [
    { name: "jobs.rerun", title: "Rerun a job", method: "POST", path: "/codecast/jobs/{id}/rerun", input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, idempotent: true, risk: "low" },
    { name: "jobs.cancel", method: "POST", path: "/codecast/jobs/{id}/cancel" },
  ],
  watches: [
    { reader: "invariants.list", every: "6h", kind: "check", map: { id: "key", ok: "passing", title: "name", detail: "detail" } },
    { reader: "jobs.failed", every: "5m", kind: "job", map: { id: "id", ok: "ok", title: "job", detail: "error", at: "failed_at" } },
  ],
};

describe("parseAppManifest", () => {
  test("normalizes a good manifest; a missing risk is high and a missing idempotent is false", () => {
    const out = parseAppManifest(manifest);
    if (!out.ok) throw new Error(out.errors.join("\n"));
    expect(out.manifest.readers.map((r) => r.name)).toEqual(["history.timeline", "invariants.list", "jobs.failed"]);
    expect(out.manifest.readers[1]).toMatchObject({ title: "invariants.list", input: { type: "object" } });
    const cancel = out.manifest.actions.find((a) => a.name === "jobs.cancel")!;
    expect(cancel).toMatchObject({ risk: "high", idempotent: false, method: "POST" });
    expect(out.manifest.watches[0]).toMatchObject({ every_ms: 6 * 3600_000, kind: "check" });
  });

  test("refuses paths that leave the base url and raw SQL readers", () => {
    for (const path of ["https://evil.example/x", "//evil.example/x", "/a/../b", "/a?x=1", "/a/%2e%2e/b", "relative"]) {
      expect(isSafeAppPath(path)).toBe(false);
    }
    expect(isSafeAppPath("/codecast/jobs/{id}/rerun")).toBe(true);
    const bad = parseAppManifest({
      name: "x",
      readers: [
        { name: "db.sql", path: "/q" },
        { name: "query", path: "/run", input: { type: "object", properties: { sql: { type: "string" } } } },
        { name: "far", path: "https://evil.example/" },
      ],
    });
    expect(bad.ok).toBe(false);
    const errors = (bad as any).errors.join("\n");
    expect(errors).toContain("reader db.sql: raw SQL");
    expect(errors).toContain("reader query: raw SQL");
    expect(errors).toContain("reader far: path");
  });

  test("checks names, methods, duplicate names, risk and watch shape", () => {
    const bad = parseAppManifest({
      name: "x",
      readers: [{ name: "a b", path: "/a" }, { name: "r", path: "/r", method: "DELETE" }, { name: "ok", path: "/ok" }, { name: "ok", path: "/ok2" }],
      actions: [{ name: "x", path: "/x", method: "GET", risk: "medium" }],
      watches: [
        { reader: "missing", every: "5m", kind: "check", map: { id: "id", ok: "ok" } },
        { reader: "ok", every: "1m", kind: "check", map: { id: "id", ok: "ok" } },
        { reader: "ok", every: "5m", kind: "job", map: { id: "id", ok: "ok" } },
      ],
    });
    expect(bad.ok).toBe(false);
    const errors = (bad as any).errors.join("\n");
    expect(errors).toContain('name "a b"');
    expect(errors).toContain("reader r: method must be GET or POST");
    expect(errors).toContain("reader ok: declared twice");
    expect(errors).toContain("action x: method must be POST");
    expect(errors).toContain('action x: risk must be "low" or "high"');
    expect(errors).toContain('no reader named "missing"');
    expect(errors).toContain("between 5m and 24h");
    expect(errors).toContain("map.at must name a row field");
    expect(parseAppManifest([]).ok).toBe(false);
    expect(parseAppManifest({ readers: [] }).ok).toBe(false);
  });
});

describe("validateJson", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      id: { type: "string", minLength: 2 },
      n: { type: "integer", minimum: 1, maximum: 5 },
      on: { type: "boolean" },
      mode: { enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["id"],
    additionalProperties: false,
  };

  test("valid args pass", () => {
    expect(validateJson(schema, { id: "ab", n: 3, on: true, mode: "a", tags: ["x"] })).toEqual([]);
  });

  test("every broken rule is named with its path", () => {
    const errors = validateJson(schema, { n: 2.5, on: "yes", mode: "c", tags: [1], extra: 1 });
    expect(errors).toEqual(
      expect.arrayContaining([
        "args.id: required",
        "args.n: expected integer, got number",
        "args.on: expected boolean, got string",
        'args.mode: must be one of "a", "b"',
        "args.tags[0]: expected string, got integer",
        "args.extra: not an argument this accepts",
      ]),
    );
    expect(validateJson(schema, { id: "a", n: 9 })).toEqual(["args.id: must be at least 2 characters", "args.n: must be at most 5"]);
    expect(validateJson(schema, "nope")).toEqual(["args: expected object, got string"]);
  });

  test("an integer satisfies number; unknown keywords are ignored", () => {
    expect(validateJson({ type: "number", format: "x" } as any, 3)).toEqual([]);
  });
});

describe("coerceArgs", () => {
  const schema: JsonSchema = { type: "object", properties: { n: { type: "integer" }, on: { type: "boolean" }, ids: { type: "array", items: { type: "number" } }, f: { type: "object" } } };
  test("reads values by their declared types", () => {
    expect(coerceArgs(schema, [["n", "4"], ["on", "false"], ["ids", "1,2"], ["ids", "3"], ["f", '{"a":1}'], ["s", "x"]])).toEqual({ n: 4, on: false, ids: [1, 2, 3], f: { a: 1 }, s: "x" });
  });
  test("refuses what a property cannot read", () => {
    expect(() => coerceArgs(schema, [["n", "four"]])).toThrow(/not a number/);
    expect(() => coerceArgs(schema, [["on", "yes"]])).toThrow(/true or false/);
  });
});

describe("buildAppRequest", () => {
  test("fills path segments, puts the rest in the query on GET", () => {
    expect(buildAppRequest("https://api.union.ai/", { method: "GET", path: "/codecast/history/{contact_id}" }, { contact_id: "a/b", limit: 5, k: ["x", "y"] })).toEqual({
      ok: true,
      url: "https://api.union.ai/codecast/history/a%2Fb?limit=5&k=x&k=y",
      method: "GET",
    });
  });
  test("sends the rest as a JSON body otherwise; a missing segment is an error", () => {
    expect(buildAppRequest("https://x.io", { method: "POST", path: "/jobs/{id}/rerun" }, { id: 7, reason: "r" })).toEqual({ ok: true, url: "https://x.io/jobs/7/rerun", method: "POST", body: '{"reason":"r"}' });
    expect(buildAppRequest("https://x.io", { method: "POST", path: "/jobs/{id}/rerun" }, {})).toEqual({ ok: false, error: "the path needs id" });
  });
});

describe("calls", () => {
  test("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });
  test("the actor header names the person and session and cannot be split", () => {
    expect(formatActorHeader({ person: "ada@x.org", session: "jx7abcd" })).toBe("person=ada@x.org; session=jx7abcd");
    expect(formatActorHeader({ person: "a;b=c\r\nX-Evil: 1" })).toBe("person=abcX-Evil: 1");
  });
});

describe("grants and the do gate", () => {
  const NOW = 1_000_000;
  const cancel = { name: "jobs.cancel", risk: "high" as const, idempotent: false };
  const rerun = { name: "jobs.rerun", risk: "low" as const, idempotent: true };

  test("an ungranted or expired action is refused", () => {
    expect(doRefusal(rerun, [], {}, NOW)).toMatch(/not granted/);
    const expired = [{ action: "jobs.rerun", granted_by: "u1", granted_at: 1, until: NOW - 1 }];
    expect(doRefusal(rerun, expired, {}, NOW)).toMatch(/not granted/);
    expect(doRefusal(rerun, [{ ...expired[0], until: NOW + 1 }], {}, NOW)).toBeNull();
  });

  test("high risk needs yes on the call; non-idempotent needs a key", () => {
    const grants = [{ action: "jobs.cancel", granted_by: "u1", granted_at: 1 }];
    expect(doRefusal(cancel, grants, { idempotency_key: "k" }, NOW)).toMatch(/--yes/);
    expect(doRefusal(cancel, grants, { yes: true }, NOW)).toMatch(/idempotency key/);
    expect(doRefusal(cancel, grants, { yes: true, idempotency_key: "k" }, NOW)).toBeNull();
  });

  test("a new grant replaces the old one and drops expired grants", () => {
    const old = [
      { action: "a", granted_by: "u1", granted_at: 1 },
      { action: "b", granted_by: "u1", granted_at: 1, until: NOW - 1 },
    ];
    const next = withGrant(old, { action: "a", granted_by: "u2", granted_at: NOW, until: NOW + 10 }, NOW);
    expect(next).toEqual([{ action: "a", granted_by: "u2", granted_at: NOW, until: NOW + 10 }]);
    expect(activeGrant(next, "a", NOW)?.granted_by).toBe("u2");
    expect(activeGrant(next, "a", NOW + 10)).toBeUndefined();
  });

  test("a grant an api token made is no grant: only a person in the browser grants", () => {
    const viaToken = [{ action: "jobs.rerun", granted_by: "u1", granted_at: 1, via: "api_token" as const }];
    expect(activeGrant(viaToken, "jobs.rerun", NOW)).toBeUndefined();
    expect(activeGrant([{ ...viaToken[0], via: "session" as const }], "jobs.rerun", NOW)).toBeDefined();
  });

  test("one check for every outside write: an app's declared actions and Sentry's writes alike", () => {
    const actions = [{ ...rerun, title: "Rerun" }];
    expect(writeRefusal(actions, [], "jobs.rerun", { grantUrl: "https://codecast.sh/ops/apps?app=src-1" }, NOW)).toContain("(https://codecast.sh/ops/apps?app=src-1)");
    expect(writeRefusal(actions, [{ action: "jobs.rerun", granted_by: "u1", granted_at: 1 }], "jobs.rerun", {}, NOW)).toBeNull();
    expect(writeRefusal(actions, [], "db.drop", {}, NOW)).toMatch(/no action db.drop/);

    expect(grantableActions("app", { actions: [{ ...rerun, title: "Rerun", method: "POST", path: "/x", input: {} }] }).map((a) => a.name)).toEqual(["jobs.rerun"]);
    expect(grantableActions("app", null)).toEqual([]);
    expect(grantableActions("sentry", null).map((a) => a.name)).toEqual(["issue.resolve", "issue.ignore"]);
    expect(grantableActions("sdk", null)).toEqual([]);
    expect([sourceHasGrants("app"), sourceHasGrants("sentry"), sourceHasGrants("posthog")]).toEqual([true, true, false]);

    expect(sentryStatusAction("resolved")).toBe("issue.resolve");
    expect(sentryStatusAction("unresolved")).toBe("issue.resolve");
    expect(sentryStatusAction("ignored")).toBe("issue.ignore");
    const resolveGrant = [{ action: "issue.resolve", granted_by: "u1", granted_at: 1 }];
    expect(writeRefusal(VENDOR_ACTIONS.sentry, resolveGrant, sentryStatusAction("unresolved"), {}, NOW)).toBeNull();
    expect(writeRefusal(VENDOR_ACTIONS.sentry, resolveGrant, sentryStatusAction("ignored"), {}, NOW)).toMatch(/issue.ignore is not granted/);
    expect(grantPagePath("src-4")).toBe("/ops/apps?app=src-4");
  });
});

describe("mapWatchRows", () => {
  const parsed = parseAppManifest(manifest);
  if (!parsed.ok) throw new Error("fixture");
  const [checkWatch, jobWatch] = parsed.manifest.watches as [AppWatch, AppWatch];
  const NOW = Date.parse("2026-10-04T12:00:00Z");

  test("check rows report red and green; unreadable rows are skipped", () => {
    const out = mapWatchRows(checkWatch, { rows: [{ key: "inv-1", passing: "failed", name: "Orphan calls", detail: { n: 3 } }, { key: "inv-2", passing: true }, { key: "", passing: true }, { key: "inv-3" }, 5] }, { now: NOW });
    if (!out.ok) throw new Error(out.error);
    expect(out.items).toEqual([
      { type: "check", id: "inv-1", ok: false, title: "Orphan calls", detail: '{"n":3}', at: NOW },
      { type: "check", id: "inv-2", ok: true, at: NOW },
    ]);
    expect(out.skipped).toBe(3);
    // Mapped items pass the door's own validation untouched.
    const batch = validateIngestBatch({ items: out.items }, NOW);
    expect(batch.ok && batch.rejected).toEqual([]);
  });

  test("a job failure listed on every poll counts once", () => {
    const rows = [
      { id: "j1", ok: false, job: "sendEmails", error: "timeout", failed_at: "2026-10-04T11:58:00Z" },
      { id: "j2", ok: false, job: "sync", failed_at: "2026-10-04T10:00:00Z" },
      { id: "j3", ok: true, job: "sync", failed_at: "2026-10-04T11:59:00Z" },
      { id: "j4", ok: false, job: "sync" },
    ];
    const first = mapWatchRows(jobWatch, rows, { now: NOW });
    if (!first.ok) throw new Error(first.error);
    // First poll: only the last `every` window counts, so old history does not flood in.
    expect(first.items).toEqual([{ type: "job_failed", job: "sendEmails", error: "timeout", job_id: "j1", at: Date.parse("2026-10-04T11:58:00Z") }]);
    expect(first.cursor).toBe(Date.parse("2026-10-04T11:59:00Z"));
    expect(first.skipped).toBe(1);
    const again = mapWatchRows(jobWatch, rows, { now: NOW + 300_000, since: first.cursor });
    expect(again.ok && again.items).toEqual([]);
  });

  test("a response that is not a list is an error", () => {
    expect(mapWatchRows(checkWatch, { ok: true }, { now: NOW })).toEqual({ ok: false, error: "reader invariants.list did not answer with a list of rows" });
  });
});
