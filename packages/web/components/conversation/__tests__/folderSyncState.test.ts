import { expect, test } from "bun:test";
import { folderSyncState } from "../FolderSyncControl";
import { planSyncChange } from "@codecast/shared/team/syncPlan";

test("a folder outside the chosen ones reads not synced, an excluded one reads excluded", () => {
  const chosen = { sync_mode: "selected" as const, sync_projects: ["/Users/david/git/littlebird"] };
  expect(folderSyncState(chosen, "/Users/rentamac/scratch")).toBe("off");
  expect(folderSyncState(chosen, "/Users/rentamac")).toBeNull();
  expect(folderSyncState(chosen, "/Users/rentamac/git/littlebird")).toBeNull();
  const all = { sync_mode: "all" as const, sync_projects: [], sync_excluded: ["/Users/david/clients"] };
  expect(folderSyncState(all, "/Users/rentamac/clients/acme")).toBe("excluded");
  expect(folderSyncState(all, "/Users/rentamac/git/app")).toBeNull();
  expect(folderSyncState(null, "/x")).toBeNull();
});

test("Sync folder adds a chosen folder, or lifts the exclusion, even one written on another machine", () => {
  expect(planSyncChange({ sync_mode: "selected", sync_projects: ["/a"] }, { sync: ["/Users/r/git/x"] }).next)
    .toEqual({ sync_mode: "selected", sync_projects: ["/a", "/Users/r/git/x"] });
  expect(planSyncChange({ sync_mode: "all", sync_projects: [], sync_excluded: ["/Users/david/clients"] }, { sync: ["/Users/r/clients"] }).next)
    .toEqual({ sync_excluded: [] });
});
