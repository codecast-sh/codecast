import { expect, test } from "bun:test";
import { followerPersistencePatches } from "../followerPersistence";

test("followers persist only explicitly per-window caches, never shared rows or UI state", () => {
  const patches = ["repoBrowse", "repoBrowseAccess", "sessions", "currentUser", "clientState", "tabs"]
    .map((key) => ({ op: "add" as const, path: [key, "id"], value: {} }));
  expect(followerPersistencePatches(patches).map((patch) => patch.path[0])).toEqual(["repoBrowse", "repoBrowseAccess"]);
});
