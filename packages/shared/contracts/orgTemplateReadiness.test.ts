import { describe, expect, test } from "bun:test";
import { instanceReadiness, routineReadiness, type ReadinessManifest, type ReadinessState } from "./orgTemplateReadiness";

const H = 3600000, D = 24 * H;
const manifest: ReadinessManifest = {
  authority: [{ id: "ads-spend", kind: "spend" }, { id: "site-write", kind: "write" }],
  evidence: [{ id: "ads_read", max_age_ms: D }, { id: "technical", max_age_ms: 7 * D }],
  routines: [
    { id: "cmo-weekly" },
    { id: "ads-daily", mode: "apply", requires: { authority: ["ads-spend"], evidence: ["ads_read"] } },
    { id: "seo-weekly", mode: "apply", requires: { authority: ["site-write"], evidence: ["technical"] } },
  ],
};
const now = 1_000_000 * D;
const state = (over: Partial<ReadinessState> = {}): ReadinessState => ({ trust: "understand", authority: [], evidence: [], ...over });

describe("routine readiness", () => {
  test("a routine with no requirements is ready and proposes", () => {
    expect(routineReadiness(manifest, manifest.routines[0]!, state(), now)).toEqual({ ready: true, mode: "propose", missing: [] });
  });
  test("missing authority and evidence block, in order", () => {
    expect(routineReadiness(manifest, manifest.routines[1]!, state(), now)).toEqual({ ready: false, mode: "propose", missing: ["authority ads-spend not granted", "evidence ads_read has no pass", "runs as propose: trust is understand"] });
    expect(routineReadiness(manifest, manifest.routines[2]!, state({ trust: "direct" }), now)).toEqual({ ready: false, mode: "propose", missing: ["authority site-write not granted", "evidence technical has no pass"] });
  });
  test("apply on spend at understand is offered, as propose (H4)", () => {
    const s = state({ authority: [{ id: "ads-spend" }], evidence: [{ check: "ads_read", status: "pass", observed_at: now - H }] });
    expect(routineReadiness(manifest, manifest.routines[1]!, s, now)).toEqual({ ready: true, mode: "propose", missing: ["runs as propose: trust is understand"] });
    expect(routineReadiness(manifest, manifest.routines[1]!, { ...s, trust: "decide" }, now)).toEqual({ ready: true, mode: "apply", missing: [] });
  });
  test("write authority at understand keeps apply: it acts on the working tree, not money or the public", () => {
    const s = state({ authority: [{ id: "site-write" }], evidence: [{ check: "technical", status: "pass", observed_at: now - D }] });
    expect(routineReadiness(manifest, manifest.routines[2]!, s, now)).toEqual({ ready: true, mode: "apply", missing: [] });
  });
  test("a lapsed pass or an expired authority lowers an active routine to propose and says why (H6)", () => {
    const s = state({ trust: "decide", authority: [{ id: "ads-spend" }], evidence: [{ check: "ads_read", status: "pass", observed_at: now - 3 * D }] });
    expect(routineReadiness(manifest, manifest.routines[1]!, s, now)).toEqual({ ready: false, mode: "propose", missing: ["evidence ads_read is 3 days old"] });
    const expired = state({ trust: "decide", authority: [{ id: "ads-spend", expires_at: now - 1 }], evidence: [{ check: "ads_read", status: "pass", observed_at: now - H }] });
    expect(routineReadiness(manifest, manifest.routines[1]!, expired, now).missing).toEqual(["authority ads-spend expired"]);
  });
  test("the latest record per check wins; a later fail replaces an earlier pass", () => {
    const s = state({ trust: "decide", authority: [{ id: "ads-spend" }], evidence: [{ check: "ads_read", status: "pass", observed_at: now - 2 * H }, { check: "ads_read", status: "fail", observed_at: now - H }] });
    expect(routineReadiness(manifest, manifest.routines[1]!, s, now).missing).toEqual(["evidence ads_read has no pass"]);
  });
  test("instanceReadiness keys every routine", () => {
    expect(Object.keys(instanceReadiness(manifest, state(), now))).toEqual(["cmo-weekly", "ads-daily", "seo-weekly"]);
  });
});
