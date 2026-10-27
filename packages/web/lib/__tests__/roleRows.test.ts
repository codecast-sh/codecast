// lib/roleRows: a face reads a role from viewerRoles whichever workspace is
// active, and finds a bot's role through the seats of every workspace.
import { describe, expect, test } from "bun:test";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";
import { roleRowsOf, roleRowsSig } from "../roleRows";
import { NO_CHARACTER_PREFS, sessionIdentity, withLiveRole } from "../sessionIdentity";

const ICON = ROLE_ICON_EXAMPLES[1].icon;
const PERSONAL = { _id: "r_alive", short_id: "or-9", handle: "aliveness", name: "Aliveness lead", given_name: "Heidi", avatar: "ibex", icon: ICON, status: "active", tenure_kind: "standing" };
const BOT = "u_bot_alive";

describe("roleRowsOf", () => {
  test("a role from another workspace resolves by id, its icon over a snapshot that predates it", () => {
    const state = { viewerRoles: { [PERSONAL._id]: PERSONAL }, orgTree: { anchors: [] }, anchors: {} };
    const stale = { _id: "c1", standing_role_id: PERSONAL._id, role: { ...PERSONAL, icon: undefined, name: "Old title" } };
    const id = sessionIdentity(withLiveRole(stale, roleRowsOf(state)), NO_CHARACTER_PREFS);
    expect(id).toMatchObject({ kind: "role", style: "icon", name: "Aliveness lead" });
    expect(id.kind === "role" && id.tile.icon).toEqual(ICON);
  });

  test("a bot's role is found through the anchors collection's seats, not only the active org tree", () => {
    const state = { viewerRoles: { [PERSONAL._id]: PERSONAL }, orgTree: { anchors: [] }, anchors: { a1: { bot_user_id: BOT, status: "active", role: { _id: PERSONAL._id } } } };
    expect(withLiveRole({ _id: "c2", acting_user_id: BOT }, roleRowsOf(state)).standing_role_id).toBe(PERSONAL._id);
  });

  test("the rows are memoized on their sources, and the signature is a short digest that moves with the icon", () => {
    const state = { viewerRoles: { [PERSONAL._id]: PERSONAL }, orgTree: null, anchors: {} };
    expect(roleRowsOf(state)).toBe(roleRowsOf(state));
    const before = roleRowsSig(state);
    expect(before.length).toBeLessThan(16);
    const redrawn = { ...state, viewerRoles: { [PERSONAL._id]: { ...PERSONAL, icon: ROLE_ICON_EXAMPLES[2].icon } } };
    expect(roleRowsSig(redrawn)).not.toBe(before);
  });

  test("a cold cache reads the active tree's roles, and only while the home is empty", () => {
    const treeRole = { ...PERSONAL, _id: "r_tree", icon: null };
    expect(roleRowsOf({ viewerRoles: {}, orgTree: { roles: [treeRole], anchors: [] }, anchors: {} }).roles).toEqual([treeRole]);
    expect(roleRowsOf({ viewerRoles: { [PERSONAL._id]: PERSONAL }, orgTree: { roles: [treeRole], anchors: [] }, anchors: {} }).roles).toEqual([PERSONAL]);
  });
});
