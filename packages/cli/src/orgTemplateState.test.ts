import { describe, expect, test } from "bun:test";
import { validateTemplate, type OrgTemplate } from "./orgTemplateArtifact";
import { markSetup, nextHumanAsk, readiness, readinessHeader, recordEvidence, recordScores, setupRows, type InstanceState } from "./orgTemplateState";

const manifest = validateTemplate({
  schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "CMO",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "c.md", caps: { hands_per_day: 1, wakes_per_day: 1, tokens_per_day: 1 } },
  authority: [{ id: "ads-spend", kind: "spend", label: "Paid search" }],
  setup: [
    { id: "search-console", title: "Verify the domain", who: "human", unlocks: ["seo"] },
    { id: "measurement", title: "See one real event", who: "role" },
    { id: "publora", title: "Connect accounts", who: "human" },
  ],
  evidence: [{ id: "ads_read", title: "API read", max_age: "24h", required_for: ["ads"] }],
  scoreboard: [{ key: "primary_events_7d", label: "Primary events" }],
  routines: [{ id: "seo", title: "SEO", every: "7d", prompt: "s.md" }, { id: "ads", title: "Ads", every: "1d", prompt: "a.md", mode: "apply", requires: { authority: ["ads-spend"], evidence: ["ads_read"] } }],
}) as OrgTemplate;
const H = 3600000;

describe("instance state", () => {
  test("evidence: declared checks only, pass or fail, a source a person can open, latest replaces", () => {
    const state: InstanceState = {};
    expect(() => recordEvidence(manifest, state, "billing", { status: "pass", source: "ct-1" })).toThrow(/Not an evidence check/);
    expect(() => recordEvidence(manifest, state, "ads_read", { status: "ok", source: "ct-1" })).toThrow(/pass or fail/);
    expect(() => recordEvidence(manifest, state, "ads_read", { status: "pass" })).toThrow(/a person can open/);
    expect(() => recordEvidence(manifest, state, "ads_read", { status: "pass", source: "trust me" })).toThrow(/a person can open/);
    recordEvidence(manifest, state, "ads_read", { status: "pass", source: "ct-41655", detail: ["customer_id=6957561342"], now: 10 });
    recordEvidence(manifest, state, "ads_read", { status: "fail", source: "https://codecast.sh/t/ct-41655", now: 20 });
    expect(state.evidence).toEqual({ ads_read: { status: "fail", observed_at: 20, source: "https://codecast.sh/t/ct-41655" } });
  });
  test("scoreboard: declared keys, each write carries a source", () => {
    const state: InstanceState = {};
    expect(() => recordScores(manifest, state, ["clicks=4"], { source: "ct-1" })).toThrow(/Not a scoreboard key/);
    expect(() => recordScores(manifest, state, ["primary_events_7d=7"], {})).toThrow(/a person can open/);
    expect(() => recordScores(manifest, state, [], { source: "ct-1" })).toThrow(/at least one/);
    recordScores(manifest, state, ["primary_events_7d=7"], { source: "ct-48702", observedAt: 5 });
    expect(state.scoreboard).toEqual({ primary_events_7d: { value: "7", observed_at: 5, source: "ct-48702" } });
  });
  test("setup: a role marks its own items with evidence; an agent cannot mark a person's step; the one ask is the first open human item", () => {
    const state: InstanceState = {};
    expect(nextHumanAsk(manifest, state)?.id).toBe("search-console");
    expect(() => markSetup(manifest, state, "search-console", { status: "done", fromAgent: true })).toThrow(/person's step/);
    expect(() => markSetup(manifest, state, "measurement", { status: "done", fromAgent: true })).toThrow(/a person can open/);
    markSetup(manifest, state, "measurement", { status: "done", evidence: "ct-48703", fromAgent: true, now: 3 });
    markSetup(manifest, state, "search-console", { status: "done", fromAgent: false, now: 4 });
    expect(nextHumanAsk(manifest, state)?.id).toBe("publora");
    markSetup(manifest, state, "publora", { status: "skipped", fromAgent: false });
    expect(nextHumanAsk(manifest, state)).toBeUndefined();
    expect(setupRows(manifest, state).map((r) => [r.id, r.status])).toEqual([["search-console", "done"], ["measurement", "done"], ["publora", "skipped"]]);
    markSetup(manifest, state, "measurement", { status: "open", fromAgent: true });
    expect(state.setup!.measurement).toEqual({ status: "open" });
  });
  test("readiness reads the receipt's evidence and authority with the manifest's ages; the header states mode and cause", () => {
    const now = 100 * 24 * H;
    const state: InstanceState = {};
    expect(readiness(manifest, state, "understand", now).seo).toEqual({ ready: true, mode: "propose", missing: [] });
    expect(readiness(manifest, state, "understand", now).ads.ready).toBe(false);
    state.authority = [{ id: "ads-spend" }];
    recordEvidence(manifest, state, "ads_read", { status: "pass", source: "ct-1", now: now - H });
    expect(readiness(manifest, state, "decide", now).ads).toEqual({ ready: true, mode: "apply", missing: [] });
    const lapsed = readiness(manifest, state, "decide", now + 48 * H).ads;
    expect(lapsed).toEqual({ ready: false, mode: "propose", missing: ["evidence ads_read is 2 days old"] });
    expect(readinessHeader("ads", lapsed)).toBe("Mode now: propose.\nNot met for ads: evidence ads_read is 2 days old.\nPropose mode: read, draft and report; make no external change, spend nothing, publish nothing.");
    expect(readinessHeader("ads", readiness(manifest, state, "decide", now).ads)).toBe("Mode now: apply.");
  });
});
