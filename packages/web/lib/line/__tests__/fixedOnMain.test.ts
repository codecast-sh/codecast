import { describe, expect, test } from "bun:test";
import { undeployedCited, ciRunOf, deployOfCommit, failingTestOf, fixCiCleared, fixCiFacts, fixedNoteRest, newestDeploy, sameCommit } from "../fixedOnMain";

describe("a problem fixed on main", () => {
  test("its note reads from the first word after the commit, never from a colon, and drops the CI word it wrote then (ct-59685)", () => {
    expect(fixedNoteRest("Already fixed on main by 5e45eba099: routes/views.ts added to NETWORK_SCOPED with general-network wall; CI run 38315388555 in progress, redeploy main once green"))
      .toBe("routes/views.ts added to NETWORK_SCOPED with general-network wall");
    expect(fixedNoteRest("Already fixed on main by fc0d85ba65 (classifies both files); CI on it in progress")).toBe("classifies both files");
    expect(fixedNoteRest("Already fixed on main by fc0d85ba65")).toBe("Already fixed on main by fc0d85ba65");
    expect(fixedNoteRest(null)).toBe("");
  });
  test("the fix's own deploy is found by its commit; short and long shas match", () => {
    const deploys = [{ at: 3, sha: "fc0d85ba6", url: null }, { at: 2, sha: "5e45eba09", url: "u" }, { at: 1, sha: null, url: null }];
    expect(sameCommit("5e45eba099", "5e45eba09")).toBe(true);
    expect(sameCommit("5e45eb", "5e45eba09")).toBe(false);
    expect(deployOfCommit("5e45eba099", deploys)).toEqual({ at: 2, sha: "5e45eba09", url: "u" });
    expect(deployOfCommit("abcdef1234", deploys)).toBeNull();
    expect(newestDeploy(deploys)?.sha).toBe("fc0d85ba6");
  });
});

describe("the fix commit's CI answers first for what failed (ct-59687)", () => {
  const base = { url: "https://github.com/Union-AI/union-mobile/commit/fc0d85b", running: [], passed: 10 };
  test("the problem's test and run are read from its words and its finding's link", () => {
    expect(failingTestOf("Main CI red at ac5c98b: networkMutationAudit.test.ts fails")).toBe("networkMutationAudit.test.ts");
    expect(failingTestOf("Callers see voicemail")).toBeNull();
    expect(ciRunOf("https://github.com/Union-AI/union-mobile/actions/runs/38315407325")).not.toBeNull();
    expect(ciRunOf("https://github.com/Union-AI/union-mobile/pull/3")).toBeNull();
  });
  test("the failing test passes on the fix; a red Vercel deploy sits apart as another check, and closing leads", () => {
    const ci = { ...base, state: "failure", failing: ["outreach-dashboard - aivery-app"], named: [{ name: "test", ok: true, url: "https://gh/job" }] };
    expect(fixCiFacts(ci, "networkMutationAudit.test.ts").map((f) => [f.k, f.v, f.tone])).toEqual([
      ["Failing test", "networkMutationAudit.test.ts passes", "ok"],
      ["Other checks", "Red: outreach-dashboard - aivery-app", "warn"],
    ]);
    expect(fixCiCleared(ci)).toBe(true);
  });
  test("still failing, or not run yet, never leads with close", () => {
    expect(fixCiCleared({ ...base, state: "success", failing: [], named: [{ name: "test", ok: false, url: null }] })).toBe(false);
    expect(fixCiFacts({ ...base, state: "success", failing: [], named: [{ name: "test", ok: null, url: null }] }, null)[0]).toMatchObject({ k: "Failed check", v: "test not run on this commit yet" });
  });
  test("with no failed run to answer for, one CI fact for the whole commit", () => {
    expect(fixCiFacts({ ...base, state: "success", failing: [] }, "x.test.ts")).toEqual([{ key: "ci", k: "CI", v: "Green, 10 passed", tone: "ok", url: `${base.url}/checks` }]);
    expect(fixCiFacts(null, null)).toEqual([{ key: "ci", k: "CI", v: "Reading" }]);
  });
});

describe("a change a finding says is not in production (ct-58847)", () => {
  test("the pull request and commit a finding says is not in prod, so the page can say whether it still holds", () => {
    const f = { created_at: 1, detail_md: "State: #3850 (e14601a557, 'Union Slack bot leads every workspace') merged to main; it is NOT in prod: prod is eea52d2." };
    expect(undeployedCited([f])).toEqual({ pr: "#3850", sha: "e14601a557" });
    expect(undeployedCited([{ created_at: 1, detail_md: "#3850 (e14601a557) merged and deployed." }])).toBeNull();
  });
});
