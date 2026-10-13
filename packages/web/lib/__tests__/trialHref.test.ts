import { describe, expect, test } from "bun:test";
import { ownWorkspace, trialAddress, trialHref } from "../trialHref";

describe("trialHref", () => {
  test("names the workspace and project a Trial tag opens, and reads them back", () => {
    const href = trialHref({ workspace: "team:t1", project: "pj-1", card: "tc-9" });
    expect(href).toBe("/trial?ws=team%3At1&project=pj-1&card=tc-9");
    expect(trialAddress(new URLSearchParams(href.split("?")[1]))).toEqual({ ws: "team:t1", project: "pj-1", card: "tc-9" });
    expect(trialHref()).toBe("/trial");
  });

  test("an address reads only a workspace the viewer is in", () => {
    expect(ownWorkspace("team:t1", "u1", ["t1", "t2"])).toBe("team:t1");
    expect(ownWorkspace("team:t9", "u1", ["t1"])).toBeNull();
    expect(ownWorkspace("user:u1", "u1", [])).toBe("user:u1");
    expect(ownWorkspace("user:u2", "u1", [])).toBeNull();
    expect(ownWorkspace("restricted:x", "u1", ["x"])).toBeNull();
    expect(ownWorkspace(null, "u1", ["t1"])).toBeNull();
  });
});
