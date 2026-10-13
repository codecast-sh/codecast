import { describe, expect, test } from "bun:test";
import { deployOfCommit, fixedNoteRest, newestDeploy, sameCommit } from "../fixedOnMain";

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
