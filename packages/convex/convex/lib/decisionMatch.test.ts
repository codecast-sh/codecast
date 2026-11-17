import { describe, expect, test } from "bun:test";
import { decisionTouches, normalizeDecisionFiles, pathCovers } from "./decisionMatch";

const change = (files: string[], ids: string[] = [], repo = "codecast-sh/codecast") => ({ repo, files, conversationIds: new Set(ids) });

describe("decisionTouches", () => {
  test("a governed directory covers files under it, not siblings sharing a prefix", () => {
    expect(pathCovers("outreach/engine/", "outreach/engine/buy.ts")).toBe(true);
    expect(pathCovers("outreach/engine", "outreach/engine/buy.ts")).toBe(true);
    expect(pathCovers("outreach/engine", "outreach/engineering.ts")).toBe(false);
  });

  test("matches by governed path in the same repo, and names the files", () => {
    const d = { repo: "codecast-sh/codecast", files: ["packages/web/store/"] };
    expect(decisionTouches(d, change(["packages/web/store/a.ts", "README.md"]))).toEqual({ files: ["packages/web/store/a.ts"], session: false });
  });

  test("the same path in another repo does not match", () => {
    expect(decisionTouches({ repo: "other/repo", files: ["src/"] }, change(["src/a.ts"]))).toBeNull();
  });

  test("matches by the session that wrote the changed lines, with no files recorded", () => {
    expect(decisionTouches({ conversation_id: "jx7abc" }, change(["x.ts"], ["jx7abc"]))).toEqual({ files: [], session: true });
  });

  test("a superseded decision binds nothing", () => {
    expect(decisionTouches({ repo: "codecast-sh/codecast", files: ["x.ts"], superseded_by: "q1" }, change(["x.ts"]))).toBeNull();
  });

  test("normalizes paths to repo-relative form", () => {
    expect(normalizeDecisionFiles(["./a/b.ts", "/c/", " d\\e.ts ", "./a/b.ts"])).toEqual(["a/b.ts", "c/", "d/e.ts"]);
  });
});
