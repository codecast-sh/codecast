// The resolver every surface goes through (docs/architecture/session-characters.md
// S1). What it decides: a role's standing session wears the ROLE, a hand under
// a role keeps its own character and only points at the role, and everything
// else wears its character — chosen or the stable default for its id.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCharacterFor } from "@codecast/shared/contracts/sessionCharacter";
import { identityLine, liveRoleSig, roleAuthorOf, roleOfUser, sessionIdentity, standingRoleOf, withLiveRole, type RoleRows } from "../sessionIdentity";
import { characterNameFor } from "@codecast/shared/contracts/sessionCharacter";

const ID = "k97xcyp74gaa0q43my0mpnvnsd8ekyj4";
const ROLE = { _id: "org_roles_infra", short_id: "or-7", name: "Infra lead", handle: "infra", avatar: "stag", status: "active", tenure_kind: "standing", given_name: "Rowan" } as const;

describe("sessionIdentity", () => {
  test("the resolver module does not import the store, so menus can load the named export", () => {
    // A value import of inboxStore from this file is a cycle: ObjectContextMenus
    // imports sessionIdentity then the store, and Vite then serves a module
    // with no named `sessionIdentity` export ("does not provide an export named").
    const src = readFileSync(join(import.meta.dir, "../sessionIdentity.ts"), "utf8");
    expect(src).not.toMatch(/^(?!import type\b)import\s[^;]*from ["']\.\.\/store\/inboxStore["']/m);
    expect(src).toMatch(/export function sessionIdentity\b/);
  });

  test("a session nobody personified stays plain — the face is opt in", () => {
    expect(sessionIdentity({ _id: ID })).toEqual({ kind: "plain", reportsTo: null });
  });

  test("the workspace switch personifies a plain session with its hash default", () => {
    const d = defaultCharacterFor(ID);
    expect(sessionIdentity({ _id: ID }, true)).toEqual({ kind: "character", avatar: d.avatar, name: d.name, chosen: false, reportsTo: null });
  });

  test("a chosen face and name win, and mark the row as chosen", () => {
    const id = sessionIdentity({ _id: ID, character_avatar: "owl", character_name: "Minerva" });
    expect(id).toEqual({ kind: "character", avatar: "owl", name: "Minerva", chosen: true, reportsTo: null });
  });

  test("a role's standing session wears the role, not its character fields", () => {
    const id = sessionIdentity({ _id: ID, standing_role_id: ROLE._id, role: { ...ROLE }, character_avatar: "fox", character_name: "Ember" });
    expect(id).toEqual({ kind: "role", avatar: "stag", name: "Rowan", handle: "infra", role: { ...ROLE } });
  });

  test("a role whose avatar key this build does not know still gets a stable face", () => {
    const id = sessionIdentity({ _id: ID, standing_role_id: ROLE._id, role: { ...ROLE, avatar: "griffin" } });
    expect(id.kind).toBe("role");
    // the handle's default, so two builds agree on the face
    expect(id.avatar).toBe(sessionIdentity({ _id: ID, standing_role_id: ROLE._id, role: { ...ROLE, avatar: "" } }).avatar);
  });

  test("a hand under a role keeps its own character and points at the role", () => {
    // Reporting to a role does NOT personify you: only the role's own standing
    // session wears the role. The pointer rides along either way, so the hover
    // card can say who this session answers to.
    expect(sessionIdentity({ _id: ID, org_role_id: ROLE._id, role: { ...ROLE } })).toEqual({ kind: "plain", reportsTo: { ...ROLE } });
    const id = sessionIdentity({ _id: ID, org_role_id: ROLE._id, role: { ...ROLE }, character_avatar: "owl" });
    expect(id.kind).toBe("character");
    if (id.kind !== "character") throw new Error("unreachable");
    expect(id.avatar).toBe("owl");
    expect(id.reportsTo).toEqual({ ...ROLE });
  });

  test("a standing pointer with no role snapshot falls back rather than throwing", () => {
    // The row claims to be a role's session but the snapshot has not synced.
    // Falling back to plain is right: inventing a character for a row that is
    // about to become a role would flash the wrong identity.
    expect(sessionIdentity({ _id: ID, standing_role_id: ROLE._id }).kind).toBe("plain");
    expect(sessionIdentity({ _id: ID, standing_role_id: ROLE._id }, true).kind).toBe("character");
  });
});

describe("identityLine", () => {
  test("a character leads with its name and keeps the title", () => {
    expect(identityLine({ _id: ID, character_name: "Ember" }, "Fixing the auth race"))
      .toEqual({ name: "Ember", title: "Fixing the auth race", handle: null });
  });

  test("a session nobody personified is the title alone, as the card always read", () => {
    expect(identityLine({ _id: ID }, "Fixing the auth race"))
      .toEqual({ name: null, title: "Fixing the auth race", handle: null });
  });

  test("a role drops a title that only repeats its name, and keeps its role title beside its name", () => {
    const row = { _id: ID, standing_role_id: ROLE._id, role: { ...ROLE } };
    expect(identityLine(row, "Rowan")).toEqual({ name: "Rowan", title: null, handle: "infra" });
    expect(identityLine(row, "Infra lead")).toEqual({ name: "Rowan", title: "Infra lead", handle: "infra" });
  });

  test("an empty or whitespace title reads as no title", () => {
    expect(identityLine({ _id: ID }, "   ").title).toBeNull();
    expect(identityLine({ _id: ID }, null).title).toBeNull();
  });
});

// A role's identity has one home, its role row (org-staffing.md S30): the
// bot user minted for its standing session is named after the role's title,
// so nothing that names the session may read it.
describe("role identity read from the role rows", () => {
  const BOT = "kd72wjbnhf1exb75acb92rtwzx8gvdva";
  const live = { _id: ROLE._id, short_id: "or-7", name: "Infra lead", handle: "infra", avatar: "hare", status: "active", given_name: null };
  const rows: RoleRows = { roles: [live], anchors: [{ bot_user_id: BOT, org_role_id: ROLE._id }, { bot_user_id: "kd7other", org_role_id: undefined }] };

  test("a role nobody named wears its face's character name, never its title", () => {
    const id = sessionIdentity({ _id: ID, standing_role_id: ROLE._id, role: { ...ROLE, given_name: null, avatar: "hare" } });
    expect(id.kind === "role" && id.name).toBe(characterNameFor(ROLE._id, "hare"));
    expect(id.kind === "role" && id.name).not.toBe("Infra lead");
  });

  test("a thin row with only the acting bot finds its role through the seat", () => {
    expect(standingRoleOf({ _id: ID, acting_user_id: BOT }, rows)).toBe(ROLE._id);
    expect(standingRoleOf({ _id: ID, acting_user_id: "kd7other" }, rows)).toBeNull();
    expect(standingRoleOf({ _id: ID }, rows)).toBeNull();
    const row = withLiveRole({ _id: ID, acting_user_id: BOT }, rows);
    expect(roleAuthorOf(row)).toEqual({ name: characterNameFor(ROLE._id, "hare"), face: "hare" });
  });

  test("the live role row wins over a stale snapshot: a rename and a new face show at once", () => {
    const stale = { _id: ID, standing_role_id: ROLE._id, role: { ...ROLE } };
    const renamed: RoleRows = { ...rows, roles: [{ ...live, given_name: "Hazel", avatar: "otter" }] };
    expect(roleAuthorOf(withLiveRole(stale, renamed))).toEqual({ name: "Hazel", face: "otter" });
    expect(liveRoleSig(stale, renamed)).not.toBe(liveRoleSig(stale, rows));
  });

  test("a row with no live role is returned as it came, and a hand under a role is not the role", () => {
    const plain = { _id: ID };
    expect(withLiveRole(plain, rows)).toBe(plain);
    expect(withLiveRole(plain, null)).toBe(plain);
    const hand = { _id: ID, org_role_id: ROLE._id, role: { ...ROLE } };
    expect(withLiveRole(hand, rows)).toBe(hand);
    expect(roleAuthorOf(hand)).toBeNull();
  });

  test("a user is read as the role it is the bot of, by its given name and face", () => {
    const named: RoleRows = { ...rows, roles: [{ ...live, given_name: "Hazel" }] };
    expect(roleOfUser(BOT, named)).toEqual({ roleId: ROLE._id, name: "Hazel", title: "Infra lead", handle: "infra", shortId: "or-7", face: "hare" });
    expect(roleOfUser(BOT, rows)?.name).toBe(characterNameFor(ROLE._id, "hare"));
    expect(roleOfUser("kd7person", rows)).toBeNull();
    expect(roleOfUser(BOT, null)).toBeNull();
    expect(roleOfUser(null, rows)).toBeNull();
  });
});
