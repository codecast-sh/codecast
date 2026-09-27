import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { orgLogEntryLine } from "@codecast/shared/contracts/orgChange";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./orgChanges.ts": () => import("./orgChanges"),
  "./orgRoles.ts": () => import("./orgRoles"),
};

test("authenticated history API applies, previews, undoes, redoes, and enforces workspace and human gates", async () => {
  const t = convexTest(schema, modules);
  const seed = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Owner" });
    const member = await ctx.db.insert("users", { name: "Member" });
    const outsider = await ctx.db.insert("users", { name: "Outsider" });
    const bot = await ctx.db.insert("users", { name: "Bot", is_bot: true });
    const team = await ctx.db.insert("teams", { name: "History", features: { org: true }, invite_code: "history-test", created_at: Date.now() });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: user, role: "admin", joined_at: Date.now() });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: member, role: "member", joined_at: Date.now() });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: bot, role: "admin", joined_at: Date.now() });
    return { user, member, outsider, bot, team };
  });
  const owner = t.withIdentity({ subject: `${seed.user}|test` });
  const member = t.withIdentity({ subject: `${seed.member}|test` });
  const outsider = t.withIdentity({ subject: `${seed.outsider}|test` });
  const role = await owner.mutation(anyApi.orgRoles.create, { name: "Growth", handle: "growth", team_id: seed.team, provision: false });
  const roleId = role._id;
  const before = await t.run((ctx) => ctx.db.get(roleId));
  await owner.mutation(anyApi.orgRoles.setCaps, { role_id: roleId, hands: 8 });
  const log = await owner.query(anyApi.orgChanges.list, { team_id: seed.team });
  expect(log.entries).toHaveLength(2);
  const batch = log.entries[0]._id;
  const detail = await owner.query(anyApi.orgChanges.get, { batch });
  expect(detail.rows).toHaveLength(1);
  expect(detail.rows[0]).not.toHaveProperty("writes");
  const preview = await owner.query(anyApi.orgChanges.previewUndo, { batch });
  expect(preview.will_change).toHaveLength(1);
  expect(preview.refused).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.caps.hands_per_day).toBe(8);
  await expect(t.withIdentity({ subject: `${seed.bot}|test` }).mutation(anyApi.orgChanges.undo, { batch })).rejects.toThrow("human only");
  await expect(member.mutation(anyApi.orgChanges.undo, { batch })).rejects.toThrow("only undo changes");
  await expect(owner.mutation(anyApi.orgChanges.undo, { batch, from_session: "test-session" })).rejects.toThrow("human only");
  await expect(outsider.query(anyApi.orgChanges.get, { batch })).rejects.toThrow("not found");
  expect(await outsider.query(anyApi.orgChanges.list, { team_id: seed.team })).toBeNull();
  const undo = await owner.mutation(anyApi.orgChanges.undo, { batch });
  const undoDetail = await owner.query(anyApi.orgChanges.get, { batch: undo.batch });
  expect(undoDetail.entry.undoes_lead).toMatchObject(detail.entry.lead);
  expect(undoDetail.entry.undoes_lead).not.toHaveProperty("writes");
  expect(orgLogEntryLine(undoDetail.entry)).toBe(`Undid "${orgLogEntryLine(detail.entry)}"`);
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.caps).toEqual(before?.caps);
  expect((await owner.mutation(anyApi.orgChanges.undo, { batch })).already_applied).toBe(true);
  const redo = await owner.mutation(anyApi.orgChanges.redo, { batch });
  const redoLog = await owner.query(anyApi.orgChanges.list, { team_id: seed.team });
  expect(redoLog.entries.find((e: any) => e._id === redo.batch)).toMatchObject({ gesture: "redo", undoes: undo.batch });
  expect(redoLog.entries.find((e: any) => e._id === batch).undone_by).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.caps.hands_per_day).toBe(8);
  await owner.mutation(anyApi.orgChanges.undo, { batch });
  expect((await t.run((ctx) => ctx.db.get(roleId)))?.caps).toEqual(before?.caps);
  expect((await owner.query(anyApi.orgChanges.list, { team_id: seed.team })).entries).toHaveLength(5);
});


test("a failed hire rolls back its role, side effects, and history together", async () => {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", { name: "Owner" }));
  const owner = t.withIdentity({ subject: `${user}|test` });
  await expect(owner.mutation(anyApi.orgRoles.create, { name: "Bad seat", handle: "bad-seat", adopt_conversation_id: "missing-session" })).rejects.toThrow();
  const rows = await t.run(async (ctx) => ({
    roles: await ctx.db.query("org_roles").collect(),
    changes: await ctx.db.query("org_changes").collect(),
    batches: await ctx.db.query("org_change_batches").collect(),
    anchors: await ctx.db.query("anchors").collect(),
  }));
  expect(rows).toEqual({ roles: [], changes: [], batches: [], anchors: [] });
});
