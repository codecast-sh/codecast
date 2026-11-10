// A finder names its role by handle; the handle is read only inside the signal's own workspace.
import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { roleIdByHandle } from "./signals";

const roles = [
  { _id: "role_a", team_id: "team_a", scope_type: "team", handle: "agent-quality", status: "active" },
  { _id: "role_b", team_id: "team_b", scope_type: "team", handle: "agent-quality", status: "active" },
  { _id: "role_p", scope_user_id: "user_1", scope_type: "user", handle: "scout", status: "active" },
];

test("a handle resolves to the role of the signal's workspace, not the first team that has one", async () => {
  const ctx = { db: makeFakeDb({ org_roles: roles }) };
  expect(await roleIdByHandle(ctx, "team:team_b", "@agent-quality")).toBe("role_b" as any);
  expect(await roleIdByHandle(ctx, "team:team_a", "agent-quality")).toBe("role_a" as any);
  expect(await roleIdByHandle(ctx, "user:user_1", "scout")).toBe("role_p" as any);
});

test("a handle that lives only in another workspace resolves to nothing", async () => {
  const ctx = { db: makeFakeDb({ org_roles: roles }) };
  expect(await roleIdByHandle(ctx, "team:team_c", "agent-quality")).toBeUndefined();
  expect(await roleIdByHandle(ctx, "user:user_2", "scout")).toBeUndefined();
  expect(await roleIdByHandle(ctx, "team:team_a", "scout")).toBeUndefined();
  expect(await roleIdByHandle(ctx, "team:team_a", undefined)).toBeUndefined();
});
