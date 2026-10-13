import { describe, expect, test } from "bun:test";
import { ciState, deployOfCommit, fixedNoteRest, newestDeploy, repoOnPath, sameCommit } from "../fixedOnMain";

describe("a problem fixed on main", () => {
  test("its note reads from the first word after the commit, never from a colon (ct-59685)", () => {
    expect(fixedNoteRest("Already fixed on main by 5e45eba099: routes/views.ts added to NETWORK_SCOPED; CI run 38315388555 in progress"))
      .toBe("Routes/views.ts added to NETWORK_SCOPED; CI run 38315388555 in progress");
    expect(fixedNoteRest("Already fixed on main by fc0d85ba65 (the guard landed there)")).toBe("The guard landed there");
    expect(fixedNoteRest(null)).toBe("");
  });
  test("the repository is the one whose name is a directory on the project's path, and only one", () => {
    expect(repoOnPath("/Users/samvit/dev/union/union-mobile/outreach", ["Union-AI/union-mobile", "codecast-sh/codecast"])).toBe("Union-AI/union-mobile");
    expect(repoOnPath("/Users/x/src/app", ["a/app", "b/app"])).toBeNull();
    expect(repoOnPath(null, ["a/app"])).toBeNull();
  });
  test("the fix's own deploy is found by its commit; short and long shas match", () => {
    const deploys = [{ at: 3, sha: "fc0d85ba6", url: null }, { at: 2, sha: "5e45eba09", url: "u" }, { at: 1, sha: null, url: null }];
    expect(sameCommit("5e45eba099", "5e45eba09")).toBe(true);
    expect(sameCommit("5e45eb", "5e45eba09")).toBe(false);
    expect(deployOfCommit("5e45eba099", deploys)).toEqual({ at: 2, sha: "5e45eba09", url: "u" });
    expect(deployOfCommit("abcdef1234", deploys)).toBeNull();
    expect(newestDeploy(deploys)?.sha).toBe("fc0d85ba6");
  });
  test("CI reads failed on any red, running while any check is unfinished, else passed", () => {
    const c = (name: string, status: string, conclusion?: string) => ({ name, status, conclusion, url: `https://x/${name}`, updated_at: 1, external_id: name });
    expect(ciState([c("CI", "completed", "success"), c("lint", "completed", "skipped")])).toMatchObject({ state: "passed", url: "https://x/CI" });
    expect(ciState([c("CI", "in_progress"), c("lint", "completed", "success")])).toMatchObject({ state: "running", running: ["CI"] });
    expect(ciState([c("CI", "completed", "failure"), c("e2e", "in_progress")])).toMatchObject({ state: "failed", failed: ["CI"], url: "https://x/CI" });
    expect(ciState([]).state).toBe("none");
  });
});
