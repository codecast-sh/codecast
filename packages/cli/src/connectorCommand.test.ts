// `cast connector` (external-data.md X8, X10): typed args, the manifest
// listings, and what each verb posts.
import { describe, expect, test } from "bun:test";
import { callArgs, formatActions, formatCallResult, splitArg, type Capabilities } from "./connectorCommand.js";
import { SCOPE, useCliHarness } from "./externalDataCli.testHarness.js";

const MANIFEST = {
  name: "union",
  version: "1",
  readers: [{ name: "history.search", title: "Search history", method: "GET", path: "/codecast/history", input: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } }, required: ["q"] } }],
  actions: [{ name: "jobs.rerun", title: "Rerun a job", method: "POST", path: "/codecast/jobs/rerun", input: { type: "object", properties: { id: { type: "string" } } }, idempotent: false, risk: "high" }],
  watches: [],
};
const CAPS: Capabilities = {
  source: { short_id: "src-5", name: "union", status: "active" },
  manifest_json: JSON.stringify(MANIFEST),
  manifest_fetched_at: 0,
  grants: [],
  watch_state: [],
};

describe("args", () => {
  test("k=v splits at the first =", () => {
    expect(splitArg("q=a=b")).toEqual(["q", "a=b"]);
    expect(() => splitArg("=x")).toThrow("key=value");
  });

  test("--args JSON, then each --arg by its declared type", () => {
    expect(callArgs('{"q":"x","extra":true}', ["limit=5"], MANIFEST.readers[0].input as any)).toEqual({ q: "x", extra: true, limit: 5 });
    expect(() => callArgs("[1]", [], undefined)).toThrow("JSON object");
    expect(() => callArgs(undefined, ["limit=lots"], MANIFEST.readers[0].input as any)).toThrow("not a number");
  });
});

describe("lines", () => {
  test("an action says whether it is granted and what each call needs", () => {
    const text = formatActions(MANIFEST.actions as any, []);
    expect(text).toContain("not granted");
    expect(text).toContain("high risk");
    expect(text).toContain("needs --idempotency-key");
    expect(formatActions(MANIFEST.actions as any, [{ action: "jobs.rerun", granted_at: 0 }])).toContain("granted");
  });

  test("a JSON answer prints pretty, a refusal prints its reason", () => {
    expect(formatCallResult({ ok: true, text: '{"a":1}', content_type: "application/json" })).toBe('{\n  "a": 1\n}');
    expect(formatCallResult({ ok: false, error: "jobs.rerun is not granted" })).toContain("not granted");
  });
});

describe("cast connector on the wire", () => {
  const h = useCliHarness("connector", async () => (await import("./connectorCommand.js")).registerConnectorCommand);

  test("read with --arg reads the manifest for types, then posts the args as JSON", async () => {
    h.answer = (p) => (p === "/cli/connector/capabilities" ? CAPS : { ok: true, text: "[]" });
    await h.run("read", "union", "history.search", "--arg", "q=refund", "--arg", "limit=3");
    expect(h.calls.map((c) => c.path)).toEqual(["/cli/connector/capabilities", "/cli/connector/read"]);
    expect(h.calls[1].body).toEqual({ source: "union", reader: "history.search", args_json: JSON.stringify({ q: "refund", limit: 3 }), ...SCOPE });
  });

  test("do sends --yes and the idempotency key; a refusal exits 1", async () => {
    h.answer = () => ({ ok: false, denied: true, error: "jobs.rerun is not granted" });
    await expect(h.run("do", "union", "jobs.rerun", "--args", '{"id":"j1"}', "--yes", "--idempotency-key", "k1")).rejects.toThrow(/exit 1/);
    expect(h.calls).toEqual([{ path: "/cli/connector/do", body: { source: "union", action: "jobs.rerun", args_json: '{"id":"j1"}', yes: true, idempotency_key: "k1", ...SCOPE } }]);
    expect(h.out()).toContain("not granted");
  });

  test("ls keeps only app sources; readers lists the manifest", async () => {
    h.answer = (p) => (p === "/cli/sources/list" ? [{ short_id: "src-1", name: "web", provider: "sdk", status: "active" }, { short_id: "src-5", name: "union", provider: "app", status: "active" }] : CAPS);
    await h.run("ls", "--json");
    await h.run("readers", "union");
    expect(JSON.parse(h.logs[0]).map((s: any) => s.name)).toEqual(["union"]);
    expect(h.out()).toContain("history.search");
  });

  test("grant and revoke never write: they name the browser page where a person does it, and exit 1", async () => {
    h.answer = () => CAPS;
    for (const verb of ["grant", "revoke"]) {
      h.logs.length = 0;
      await expect(h.run(verb, "union", "jobs.rerun")).rejects.toThrow(/exit 1/);
      expect(h.out()).toContain("is a person's call, made in the browser");
      expect(h.out()).toMatch(/https?:\/\/\S+\/ops\/apps\?app=src-5/);
    }
    h.logs.length = 0;
    await expect(h.run("grant", "union", "db.drop")).rejects.toThrow(/exit 1/);
    expect(h.out()).toContain("has no action db.drop (it has: jobs.rerun)");
    expect(h.calls.every((c) => c.path === "/cli/connector/capabilities")).toBe(true);
  });

  test("a Sentry source lists its writes and their grants", async () => {
    h.answer = () => ({ ...CAPS, source: { short_id: "src-2", name: "errors", provider: "sentry", status: "active" }, manifest_json: null, grants: [{ action: "issue.resolve", granted_at: 0 }] });
    await h.run("actions", "errors");
    expect(h.out()).toContain("issue.resolve");
    expect(h.out()).toContain("issue.ignore");
    expect(h.out()).toMatch(/issue\.resolve.*granted/);
    expect(h.out()).toMatch(/issue\.ignore.*not granted/);
  });
});
