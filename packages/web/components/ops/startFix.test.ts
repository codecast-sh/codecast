import { describe, expect, test } from "bun:test";
import { fixSessionPath } from "./startFix";

// A fix starts where the signal's source points (its project), not wherever
// the person last looked; only a source with no project falls back.
const base = {
  currentConversation: { projectPath: "/src/other-repo" },
  projects: { p1: { _id: "p1", project_path: "/src/shop" } } as Record<string, any>,
  opsSources: { s1: { _id: "s1", project_id: "p1" }, s2: { _id: "s2" } } as Record<string, any>,
};

describe("fixSessionPath", () => {
  test("the source's project wins over the page the person was on", () => {
    expect(fixSessionPath(base as any, "s1")).toBe("/src/shop");
  });
  test("a source with no project, or no source, falls back to the default", () => {
    expect(fixSessionPath(base as any, "s2")).toBe("/src/other-repo");
    expect(fixSessionPath(base as any, undefined)).toBe("/src/other-repo");
  });
});
