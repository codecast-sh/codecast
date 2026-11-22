import { describe, expect, it } from "bun:test";
import { chipFilterOpts, chipMatchesSession, computeChipCounts, groupSessionsByMachine, type InboxSession } from "../inboxStore";
import { inboxViewModes } from "../inboxViewModes";
import { machineChipKey, projectAxisNoun } from "../workProjects";

// Machines as an inbox filter and grouping: a session answers to `mc:<device>`
// (its owner_device_id) on the folder chip axis, so "only m2-pro" and
// "everything but m2-pro" are the folder chip's include and exclude.

const row = (id: string, extra: Partial<InboxSession> = {}): InboxSession =>
  ({ _id: id.padEnd(32, "x"), session_id: id, updated_at: 1, project_path: "/Users/me/src/app", git_root: "/Users/me/src/app", ...extra }) as InboxSession;

const a1 = row("a1", { owner_device_id: "m2pro" });
const a2 = row("a2", { owner_device_id: "m2pro", project_path: "/Users/me/src/other", git_root: "/Users/me/src/other" });
const b1 = row("b1", { owner_device_id: "m5max" });
const none = row("none");
const all = [a1, a2, b1, none];

const visible = (filter: string, exclude = false) =>
  all
    .filter((s) => chipMatchesSession(s, chipFilterOpts({ activeProjectFilter: filter, chipFilterExclude: exclude }, {})))
    .map((s) => s.session_id);

describe("machine chips", () => {
  it("count per machine, biggest first, apart from folders", () => {
    const { projectCounts, machineCounts } = computeChipCounts(all, {});
    expect(machineCounts).toEqual([[machineChipKey("m2pro"), 2], [machineChipKey("m5max"), 1]]);
    expect(projectCounts.every(([k]) => projectAxisNoun(k) === "folder")).toBe(true);
  });

  it("include shows only that machine's sessions; exclude hides them", () => {
    expect(visible(machineChipKey("m2pro"))).toEqual(["a1", "a2"]);
    expect(visible(machineChipKey("m2pro"), true)).toEqual(["b1", "none"]);
  });

  it("a folder chip still works alongside machine keys", () => {
    expect(visible("app")).toEqual(["a1", "b1", "none"]);
  });

  it("names the key's kind", () => {
    expect(projectAxisNoun(machineChipKey("m2pro"))).toBe("machine");
    expect(projectAxisNoun("pj:abc")).toBe("project");
    expect(projectAxisNoun("app")).toBe("folder");
  });
});

describe("group by machine", () => {
  it("one group per machine, biggest first; unowned sessions fall to folders", () => {
    const { machineGroups, projectGroups } = groupSessionsByMachine(all);
    expect(machineGroups.map((g) => [g.deviceId, g.items.map((s) => s.session_id)])).toEqual([
      ["m2pro", ["a1", "a2"]],
      ["m5max", ["b1"]],
    ]);
    expect(projectGroups).toEqual([{ name: "app", items: [none] }]);
  });

  it("is offered only when sessions run on more than one machine", () => {
    const base = { hasLabels: false, hasPlans: false, orgLenses: [], hasTriggers: false };
    expect(inboxViewModes({ ...base, hasMachines: true })).toContain("machine");
    expect(inboxViewModes({ ...base, hasMachines: false })).not.toContain("machine");
  });
});
