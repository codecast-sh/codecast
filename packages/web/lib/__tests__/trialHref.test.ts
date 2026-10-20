import { describe, expect, test } from "bun:test";
import { lineFromName, ownWorkspace, trialAddress, trialHref } from "../trialHref";

describe("trialHref", () => {
  test("names the workspace and project a Trial tag opens, and reads them back", () => {
    const href = trialHref({ workspace: "team:t1", project: "pj-1", card: "tc-9" });
    expect(href).toBe("/trial?ws=team%3At1&project=pj-1&card=tc-9");
    expect(trialAddress(new URLSearchParams(href.split("?")[1]))).toEqual({ ws: "team:t1", project: "pj-1", card: "tc-9", from: null });
    expect(trialHref()).toBe("/trial");
  });

  test("carries the /line item it was opened from, and nothing else, as the way back", () => {
    const href = trialHref({ card: "tc-69", from: "/line?need=sd-600" });
    expect(trialAddress(new URLSearchParams(href.split("?")[1])).from).toBe("/line?need=sd-600");
    expect(trialHref({ from: "https://evil.example/line" })).toBe("/trial");
    expect(trialHref({ from: "/tasks/ct-1" })).toBe("/trial");
    expect(lineFromName("/line?need=sd-600")).toBe("Decisions");
    expect(lineFromName("/line?view=problems&case=ct-1")).toBe("Problems");
    expect(lineFromName("/line?view=line&step=prove")).toBe("Line");
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
