import { describe, expect, test } from "bun:test";
import { adoptChange, adoptDropRefusal, rowDropZone, viewerOwns, type AdoptRow } from "../adoptDrop";
import type { SessionOwnerFacts } from "@codecast/shared/contracts/sessionOwners";
import type { SessionOwnersRow } from "../../store/sessionOwnersSlice";

// A session card dropped on another row in the sidebar makes it that row's
// worker. These are the rules the sidebar lights a row by, and the change it sends.

const ME = "me";
const MATE = "mate";
const row = (id: string, over: Partial<AdoptRow> = {}): AdoptRow => ({ _id: id, owners_model: true, user_id: ME, owned_by_me: true, ...over });
const facts = (over: Partial<SessionOwnerFacts> = {}): SessionOwnerFacts => ({ conversation_id: "a", rows: [{ user_id: ME, added_at: 10 }], starter: ME, user_id: ME, ...over });
const parents = (map: Record<string, string>) => (id: string) => map[id] ?? null;
const ownedByMe = { facts: facts(), canEdit: true };
const target = { facts: facts({ conversation_id: "b" }), canEdit: true };
const base = { draggedOwners: ownedByMe, targetOwners: target, viewerId: ME, parentOf: parents({}) };

describe("adoptDropRefusal", () => {
  test("takes a session the viewer owns onto another of theirs", () => {
    expect(adoptDropRefusal({ ...base, dragged: row("a"), target: row("b") })).toBeNull();
  });

  test("refuses itself", () => {
    expect(adoptDropRefusal({ ...base, dragged: row("a"), target: row("a") })).toMatch(/itself/);
  });

  test("refuses either row off the owners model", () => {
    expect(adoptDropRefusal({ ...base, dragged: row("a", { owners_model: undefined }), target: row("b") })).toMatch(/model/);
    expect(adoptDropRefusal({ ...base, dragged: row("a"), target: row("b", { owners_model: false }) })).toMatch(/model/);
  });

  test("refuses a session nested by how it runs: a subagent, a workflow station, a plan handoff", () => {
    for (const over of [{ is_subagent: true }, { is_workflow_sub: true }, { parent_message_uuid: "plan-handoff" }]) {
      expect(adoptDropRefusal({ ...base, dragged: row("a", over), target: row("b") })).toMatch(/by how it was started/);
    }
  });

  test("refuses a role's standing session", () => {
    expect(adoptDropRefusal({ ...base, dragged: row("a", { standing_role_id: "r1" }), target: row("b") })).toMatch(/role's own session/);
  });

  test("refuses a killed or closed target", () => {
    expect(adoptDropRefusal({ ...base, dragged: row("a"), target: row("b", { inbox_killed_at: 5 }) })).toMatch(/killed/);
    expect(adoptDropRefusal({ ...base, dragged: row("a"), target: row("b", { inbox_closed_at: 5, inbox_dismissed_at: 5 }) })).toMatch(/closed/);
  });

  test("refuses a target nested under the dragged session, at any depth, and ends a loop", () => {
    expect(adoptDropRefusal({ ...base, parentOf: parents({ b: "c", c: "a" }), dragged: row("a"), target: row("b") })).toMatch(/already works/);
    expect(adoptDropRefusal({ ...base, parentOf: parents({ b: "c", c: "b" }), dragged: row("a"), target: row("b") })).toBeNull();
  });

  test("refuses the parent it already works for", () => {
    expect(adoptDropRefusal({ ...base, draggedOwners: { facts: facts({ parent_conversation_id: "b" }), canEdit: true }, dragged: row("a"), target: row("b") })).toMatch(/already works/);
  });

  test("refuses a viewer who may not edit its owners", () => {
    const f = facts({ rows: [{ user_id: MATE, added_at: 1 }], user_id: "runner" });
    expect(adoptDropRefusal({ ...base, draggedOwners: { facts: f, canEdit: false }, dragged: row("a", { user_id: "runner" }), target: row("b") })).toMatch(/Only its owners/);
  });

  test("refuses a target the viewer neither owns nor runs", () => {
    const theirs = { facts: facts({ conversation_id: "b", rows: [{ user_id: MATE, added_at: 1 }], user_id: MATE }), canEdit: false };
    expect(adoptDropRefusal({ ...base, targetOwners: theirs, dragged: row("a"), target: row("b", { user_id: MATE, owned_by_me: false }) })).toMatch(/own or run/);
    const unread = { facts: null, canEdit: false };
    expect(adoptDropRefusal({ ...base, targetOwners: unread, dragged: row("a"), target: row("b", { user_id: MATE, owned_by_me: false }) })).toMatch(/own or run/);
    expect(adoptDropRefusal({ ...base, targetOwners: unread, dragged: row("a"), target: row("b", { user_id: MATE, owned_by_me: true }) })).toBeNull();
  });

  test("without an owners read, the row's stamps decide", () => {
    const noRead = { ...base, draggedOwners: { facts: null, canEdit: false } };
    expect(adoptDropRefusal({ ...noRead, dragged: row("a", { user_id: "runner", owned_by_me: false }), target: row("b") })).toMatch(/Only its owners/);
    expect(adoptDropRefusal({ ...noRead, dragged: row("a", { user_id: "runner", owned_by_me: false, implicit_owner: ME }), target: row("b") })).toBeNull();
  });
});

describe("viewerOwns", () => {
  test("an owner row or the implicit starter owns it; running it alone does not", () => {
    expect(viewerOwns(row("a"), ownedByMe, ME)).toBe(true);
    expect(viewerOwns(row("a"), { facts: facts({ rows: [] }), canEdit: true }, ME)).toBe(true);
    expect(viewerOwns(row("a"), { facts: facts({ rows: [{ user_id: MATE, added_at: 1 }] }), canEdit: true }, ME)).toBe(false);
  });
});

describe("rowDropZone", () => {
  const z = (y: number, opts: Parameters<typeof rowDropZone>[3]) => rowDropZone(y, 100, 40, opts);

  test("a reorderable row keeps its quarters for the line and adopts in the middle", () => {
    const opts = { reorderable: true, adoptable: true };
    expect([z(105, opts), z(115, opts), z(125, opts), z(135, opts)]).toEqual(["before", "adopt", "adopt", "after"]);
  });

  test("a row that only adopts is all adopt", () => {
    expect([z(101, { reorderable: false, adoptable: true }), z(139, { reorderable: false, adoptable: true })]).toEqual(["adopt", "adopt"]);
  });

  test("a row in a drop section leaves its edges to the section", () => {
    const opts = { reorderable: false, adoptable: true, sectionDrop: true };
    expect([z(105, opts), z(120, opts), z(135, opts)]).toEqual([null, "adopt", null]);
  });

  test("a refused row reorders by halves, or takes nothing", () => {
    expect([z(115, { reorderable: true, adoptable: false }), z(125, { reorderable: true, adoptable: false })]).toEqual(["before", "after"]);
    expect(z(120, { reorderable: false, adoptable: false })).toBeNull();
  });
});

describe("adoptChange", () => {
  const read = { people_info: { [ME]: { user_id: ME, name: "Me", email: null, added_by: MATE, added_at: 10, seen_at: 12, note: null } } } as unknown as SessionOwnersRow;
  const mine = { user_id: ME, added_by: MATE, added_at: 10, seen_at: 12 };

  test("with no parent before, undo detaches it and puts the viewer's row back", () => {
    expect(adoptChange(facts(), read, ME, "b", () => true)).toEqual({
      change: { adopt_parent: "b" },
      inverse: [{ detach_parent: true, restore: [mine] }],
    });
  });

  test("with no parent before, undo puts its role back too", () => {
    expect(adoptChange(facts({ org_role_id: "r1" }), read, ME, "b", () => true).inverse).toEqual([{ detach_parent: true, role: "r1", restore: [mine] }]);
  });

  test("a live parent that owned it comes back; a released or dead one owned nothing, so it detaches", () => {
    expect(adoptChange(facts({ parent_conversation_id: "old" }), read, ME, "b", () => true).inverse).toEqual([{ adopt_parent: "old", restore: [mine] }]);
    // The owners read names no parent once it is released or dead.
    expect(adoptChange(facts({ parent_conversation_id: "old", parent_released_at: 0 }), read, ME, "b", () => true).inverse).toEqual([{ detach_parent: true, restore: [mine] }]);
  });

  test("a parent a person released it from: undo nests it back released, then puts its role back", () => {
    const released = { ...read, released_parent: { conversation_id: "old", short_id: "o1", title: "Old" } } as unknown as SessionOwnersRow;
    expect(adoptChange(facts({ org_role_id: "r1" }), released, ME, "b", () => true).inverse).toEqual([{ adopt_parent: "old", release_parent: true, restore: [mine] }, { role: "r1" }]);
    // An open read that says no parent can take it back wins over the card's link.
    expect(adoptChange(facts(), { ...read, released_parent: null } as unknown as SessionOwnersRow, ME, "b", () => true, "old").inverse).toEqual([{ detach_parent: true, restore: [mine] }]);
    // A card's row keeps the link when no open read names it.
    expect(adoptChange(facts(), read, ME, "b", () => true, "old").inverse).toEqual([{ adopt_parent: "old", release_parent: true, restore: [mine] }]);
    // One the viewer may not hand work to: the link is let go, as before.
    expect(adoptChange(facts(), released, ME, "b", (id) => id !== "old").inverse).toEqual([{ detach_parent: true, restore: [mine] }]);
  });

  test("an implicit starter's undo puts nobody's row back", () => {
    expect(adoptChange(facts({ rows: [] }), null, ME, "b", () => true).inverse).toEqual([{ detach_parent: true }]);
  });

  test("a viewer who does not run it rejoins first, then puts it back", () => {
    expect(adoptChange(facts({ user_id: "runner" }), read, ME, "b", () => true).inverse).toEqual([{ add: [ME] }, { detach_parent: true, restore: [mine] }]);
  });

  test("no undo when it had both a role and a parent", () => {
    expect(adoptChange(facts({ org_role_id: "r1", parent_conversation_id: "old" }), read, ME, "b", () => true).inverse).toBeNull();
    // Its old parent is a session the viewer may not hand work to: the server
    // would refuse putting it back, so no undo is offered.
    expect(adoptChange(facts({ parent_conversation_id: "old" }), read, ME, "b", (id) => id !== "old").inverse).toBeNull();
  });
});
