import { describe, expect, it } from "bun:test";
import { serverErrorText } from "../errorCause";

describe("serverErrorText", () => {
  it("keeps the sentence and drops the Convex envelope, stack and JSON body", () => {
    const raw =
      '[CONVEX A(repos:ensureCommitFiles)] [Request ID: dd12bf14f1db4737] Server Error ' +
      'Uncaught Error: Uncaught Error: GitHub API error: 422 ' +
      '{"message":"No commit found for SHA: beef0011","documentation_url":"https://docs.github.com/x","status":"422"} ' +
      'at ghFetch (../convex/githubApi.ts:460:9) at async handler (../convex/repos.ts:415:6) Called by client';
    expect(serverErrorText(new Error(raw))).toBe(
      "GitHub API error: 422 No commit found for SHA: beef0011",
    );
  });

  it("leaves a plain message alone", () => {
    expect(serverErrorText(new Error("No GitHub App installation you can use covers a/b"))).toBe(
      "No GitHub App installation you can use covers a/b",
    );
  });

  it("survives a body that is not JSON", () => {
    expect(serverErrorText(new Error("Something broke {not json}"))).toBe("Something broke {not json}");
  });

  it("never answers empty, so a surface always has something to show", () => {
    expect(serverErrorText(new Error("[CONVEX A(x)] Server Error Uncaught Error:"))).toBe(
      "[CONVEX A(x)] Server Error Uncaught Error:",
    );
  });
});
