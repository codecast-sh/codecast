import { describe, expect, test } from "bun:test";
import { roleIdentity, roleIdentityLine } from "./orgIdentity";
import { characterNameFor } from "./sessionCharacter";
import { avatarOf } from "./orgAvatars";

// A role is named like a person, with its role as the subtitle (org-staffing.md S30).
describe("roleIdentity", () => {
  const head = { _id: "or1", name: "Head of People", handle: "head-of-people", avatar: "owl" };

  test("wears its face's character name until a person chooses one", () => {
    const id = roleIdentity(head);
    expect(id.name).toBe(characterNameFor("or1", avatarOf(head)));
    expect(id.chosen).toBe(false);
    expect(id.title).toBe("Head of People");
    expect(id.subtitle).toBe("Head of People");
    expect(roleIdentity({ ...head, given_name: "  Rowan " })).toMatchObject({ name: "Rowan", chosen: true });
    expect(roleIdentity({ ...head, given_name: "   " }).chosen).toBe(false);
  });

  test("a legacy Head of People row reads under its new title until migrated", () => {
    expect(roleIdentity({ _id: "or3", name: "Chief of Staff", handle: "chief-of-staff" }).title).toBe("Head of People");
    expect(roleIdentity({ _id: "or3", name: "Ops chief", handle: "chief-of-staff" }).title).toBe("Ops chief");
  });

  test("an assistant's subtitle carries its reach", () => {
    const base = { _id: "or2", name: "Executive Assistant", handle: "executive-assistant", given_name: "Ada" };
    expect(roleIdentityLine({ ...base, assistant: { reach: "global" }, scope_type: "user" })).toBe("Ada · Executive Assistant, global");
    expect(roleIdentity({ ...base, assistant: { reach: "team", team_id: "t1" }, scope_type: "team" }, { teamName: "Acme" }).subtitle).toBe("Executive Assistant, Acme");
    expect(roleIdentity({ ...base, assistant: { reach: "team", team_id: "t1" }, scope_type: "user" }, { teamName: "Acme" }).subtitle).toBe("Executive Assistant, personal, Acme");
    // The title is the assistant's whatever the row's name says.
    expect(roleIdentity({ ...base, name: "Right hand", assistant: { reach: "global" } }).title).toBe("Executive Assistant");
  });
});
