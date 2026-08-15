// syncRepositoriesForUser drives the GitHub API with the target user's stored
// github_access_token. As a public action taking a raw user_id it let ANY
// internet caller — authenticated or not — spend any user's GitHub credential.
// Nothing outside convex calls it, so the fix is to make it internal: convex
// marks public functions with isPublic, and only those are callable from
// clients.
import { describe, expect, test } from "bun:test";
import { syncRepositoriesForUser } from "./commits";

describe("syncRepositoriesForUser exposure", () => {
  test("is not a public (client-callable) function", () => {
    expect((syncRepositoriesForUser as any).isPublic).not.toBe(true);
  });
});
