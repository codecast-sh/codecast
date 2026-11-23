/** Which inline code a conversation reads as a branch (docs/architecture/changes.md CH4). */
import { describe, expect, test } from "bun:test";
import { looksLikeBranch } from "../useMentionedChange";

describe("looksLikeBranch", () => {
  test("branches agents write", () => {
    for (const t of ["evals/budget-checks", "ship/ct-98647", "codecast/change-ct-98647", "release/1.2", "fix/ct_12", "pl-1074/ship-model"]) expect([t, looksLikeBranch(t)]).toEqual([t, true]);
  });
  test("paths, refs and prose that are not", () => {
    for (const t of ["origin/main", "owner/repo", "text/html", "and/or", "24/7", "hooks/useX", "backend/src", "packages/web/lib/x", "lib/foo.ts", "a b/c", ".github/workflows", "src/my-thing"]) expect([t, looksLikeBranch(t)]).toEqual([t, false]);
  });
});
