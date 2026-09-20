import { describe, expect, it } from "bun:test";
import { assigneeLabelOf, mergeLiveTasks, resolveAssigneeInfo } from "../liveEntities";

// org-roles-run-work.md R5: a role is an assignee the way a person is.
const members = [{ _id: "u1", name: "Jason", image: "jpg", github_username: "jbenn" }];
const roles = [{ _id: "r1", short_id: "or-8", name: "Head of Growth", handle: "growth", avatar: "fox" }];
const growth = { kind: "role", name: "Head of Growth", handle: "growth", avatar: "fox", role_id: "r1", role_short_id: "or-8" };

describe("resolveAssigneeInfo with roles", () => {
  it("resolves a role id to its face, name and handle from the org tree slice", () => {
    expect(resolveAssigneeInfo("r1", null, members, null, roles)).toEqual(growth as any);
  });

  it("the slice wins over a stale server snapshot, so a rename shows at once", () => {
    const stale = { ...growth, name: "Growth" };
    expect(resolveAssigneeInfo("r1", stale, members, null, roles)).toEqual(growth as any);
  });

  it("a person still resolves as a person when roles are passed", () => {
    expect(resolveAssigneeInfo("u1", null, members, null, roles)).toEqual({ name: "Jason", image: "jpg", github_username: "jbenn" });
  });

  it("falls to the server's answer when the slice has not loaded", () => {
    expect(resolveAssigneeInfo("r1", growth, members, null, undefined)).toEqual(growth as any);
    expect(resolveAssigneeInfo("r1", growth, members, null, [])).toEqual(growth as any);
  });
});

describe("an assignee nobody here can resolve", () => {
  const gone = "u".repeat(32);
  it("an id outside the roster and the roles names nobody, not a 32 character string", () => {
    expect(resolveAssigneeInfo(gone, undefined, members, null, roles)).toBeNull();
    // The server's own answer still wins when it has one.
    expect(resolveAssigneeInfo(gone, { name: "Priya" }, members, null, roles)).toEqual({ name: "Priya" });
  });

  it("a bare name typed by hand still names a person", () => {
    expect(resolveAssigneeInfo("Priya", undefined, members, null, roles)).toEqual({ name: "Priya" });
  });

  it("a chain head outside the team is labelled as such on the board", () => {
    expect(assigneeLabelOf(gone, null)).toBe("Outside the team");
    expect(assigneeLabelOf("Priya", null)).toBe("Priya");
    expect(assigneeLabelOf(gone, { name: "Jason" })).toBe("Jason");
  });
});

describe("mergeLiveTasks with roles", () => {
  it("a task handed to a role in the store shows the role before the server echo", () => {
    const snapshot = [{ _id: "t1", assignee: "u1", assignee_info: { name: "Jason", image: "jpg", github_username: "jbenn" } }];
    const [row] = mergeLiveTasks(snapshot, { t1: { assignee: "r1" } }, members, null, roles);
    expect(row.assignee).toBe("r1");
    expect(row.assignee_info).toEqual(growth);
  });

  it("keeps the row's reference when the role did not change", () => {
    const snapshot = [{ _id: "t1", assignee: "r1", assignee_info: growth }];
    expect(mergeLiveTasks(snapshot, {}, members, null, roles)[0]).toBe(snapshot[0]);
  });
});
