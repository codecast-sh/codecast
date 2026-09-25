import { describe, expect, test } from "bun:test";
import { pickWhoRows } from "../palettePick";

const people = [
  { key: "u-ann", label: "Ann Lee" },
  { key: "u-bo", label: "Bo Park" },
  { key: "u-me", label: "Me Myself" },
];
const roles = [
  { key: "r-ops", label: "Operations", hint: "@ops" },
  { key: "r-idle", label: "Idle Seat", hint: "@idle" },
];
const standing = new Map<string, string | undefined>([["r-ops", "conv-ops"], ["r-idle", undefined]]);

describe("the call's add list: people and roles", () => {
  test("teammates by id and roles by their standing agent's session; a role with no agent is not offered", () => {
    const rows = pickWhoRows({ people, roles, standing, skip: new Set(["u-me"]), query: "" });
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(["person:u-ann", "person:u-bo", "role:conv-ops"]);
  });

  test("who is already in the call (a person in the room, a role's agent already routed) is left out", () => {
    const rows = pickWhoRows({ people, roles, standing, skip: new Set(["u-me", "u-ann", "conv-ops"]), query: "" });
    expect(rows.map((r) => r.id)).toEqual(["u-bo"]);
  });

  test("the query matches a name or a role's handle", () => {
    expect(pickWhoRows({ people, roles, standing, skip: new Set(), query: "bo" }).map((r) => r.id)).toEqual(["u-bo"]);
    expect(pickWhoRows({ people, roles, standing, skip: new Set(), query: "ops" }).map((r) => r.id)).toEqual(["conv-ops"]);
  });

  test("a pick that allows only one kind lists only that kind", () => {
    expect(pickWhoRows({ people: null, roles, standing, skip: new Set(), query: "" }).map((r) => r.kind)).toEqual(["role"]);
  });
});
