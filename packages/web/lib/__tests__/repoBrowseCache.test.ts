import { expect, test } from "bun:test";
import { repoBrowseKey, repoViewerScope, retainRepoBrowseRows } from "../repoBrowseCache";

test("cache scope follows the authenticated subject, never a stale currentUser", () => {
  const token = `header.${btoa(JSON.stringify({ sub: "new-user|session" })).replace(/=/g, "")}.signature`;
  expect(repoViewerScope(token, "old-user")).toBeNull();
  expect(repoViewerScope(token, "new-user")).toBe("new-user|session");
  expect(repoViewerScope(null, "new-user")).toBeNull();
  expect(repoViewerScope("invalid", "new-user")).toBeNull();
});
test("payload keys isolate users, query parameters and payload kinds", () => {
  const args = { repository: "o/r", ref: "main", path: "src" };
  expect(repoBrowseKey("a", "tree", args)).not.toBe(repoBrowseKey("b", "tree", args));
  expect(repoBrowseKey("a", "tree", args)).not.toBe(repoBrowseKey("a", "blob", args));
  expect(repoBrowseKey("a", "tree", args)).toBe(repoBrowseKey("a", "tree", { path: "src", ref: "main", repository: "o/r", extra: undefined }));
});
test("on-demand cache is bounded and drops payloads from a previous subject", () => {
  const row = (i: number, scope = "a") => ({ _id: String(i), scope, repository: "o/r", kind: "tree", value: {}, updated_at: i });
  const current = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [String(i), row(i)]));
  current.other = row(-1, "other");
  const kept = retainRepoBrowseRows(current, row(151));
  expect(kept).toHaveLength(96);
  expect(kept.every((r) => r.scope === "a")).toBe(true);
  expect(kept[0]._id).toBe("151");
});
