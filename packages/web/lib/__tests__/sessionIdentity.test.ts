// The resolver every surface goes through (docs/architecture/session-characters.md
// S1). What it decides: a role's standing session wears the ROLE, a hand under
// a role keeps its own character and only points at the role, and everything
// else wears its character — chosen or the stable default for its id.
import { describe, expect, test } from "bun:test";
import { defaultCharacterFor } from "@codecast/shared/contracts/sessionCharacter";
import { identityLine, sessionIdentity } from "../sessionIdentity";

const ID = "k97xcyp74gaa0q43my0mpnvnsd8ekyj4";
const ROLE = { _id: "org_roles_infra", short_id: "or-7", name: "Infra lead", handle: "infra", avatar: "stag", status: "active", tenure_kind: "standing" } as const;

describe("sessionIdentity", () => {
  test("a plain session wears its hash default until something is chosen", () => {
    const d = defaultCharacterFor(ID);
    const id = sessionIdentity({ _id: ID });
    expect(id).toEqual({ kind: "character", avatar: d.avatar, name: d.name, chosen: false, reportsTo: null });
  });

  test("a chosen face and name win, and mark the row as chosen", () => {
    const id = sessionIdentity({ _id: ID, character_avatar: "owl", character_name: "Minerva" });
    expect(id).toEqual({ kind: "character", avatar: "owl", name: "Minerva", chosen: true, reportsTo: null });
  });

  test("a role's standing session wears the role, not its character fields", () => {
    const id = sessionIdentity({ _id: ID, standing_role_id: ROLE._id, role: { ...ROLE }, character_avatar: "fox", character_name: "Ember" });
    expect(id).toEqual({ kind: "role", avatar: "stag", name: "Infra lead", handle: "infra", role: { ...ROLE } });
  });

  test("a role whose avatar key this build does not know still gets a stable face", () => {
    const id = sessionIdentity({ _id: ID, standing_role_id: ROLE._id, role: { ...ROLE, avatar: "griffin" } });
    expect(id.kind).toBe("role");
    // the handle's default, so two builds agree on the face
    expect(id.avatar).toBe(sessionIdentity({ _id: ID, standing_role_id: ROLE._id, role: { ...ROLE, avatar: "" } }).avatar);
  });

  test("a hand under a role keeps its own character and points at the role", () => {
    const id = sessionIdentity({ _id: ID, org_role_id: ROLE._id, role: { ...ROLE } });
    expect(id.kind).toBe("character");
    if (id.kind !== "character") throw new Error("unreachable");
    expect(id.avatar).toBe(defaultCharacterFor(ID).avatar);
    expect(id.reportsTo).toEqual({ ...ROLE });
  });

  test("a standing pointer with no role snapshot falls back rather than throwing", () => {
    expect(sessionIdentity({ _id: ID, standing_role_id: ROLE._id }).kind).toBe("character");
  });
});

describe("identityLine", () => {
  test("a character leads with its name and keeps the title", () => {
    expect(identityLine({ _id: ID, character_name: "Ember" }, "Fixing the auth race"))
      .toEqual({ name: "Ember", title: "Fixing the auth race", handle: null });
  });

  test("a role drops a title that only repeats its name", () => {
    const row = { _id: ID, standing_role_id: ROLE._id, role: { ...ROLE } };
    expect(identityLine(row, "Infra lead")).toEqual({ name: "Infra lead", title: null, handle: "infra" });
    expect(identityLine(row, "Rolling the canary")).toEqual({ name: "Infra lead", title: "Rolling the canary", handle: "infra" });
  });

  test("an empty or whitespace title reads as no title", () => {
    expect(identityLine({ _id: ID }, "   ").title).toBeNull();
    expect(identityLine({ _id: ID }, null).title).toBeNull();
  });
});
