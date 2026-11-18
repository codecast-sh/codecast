// A session started from codecast has no repo recorded until its agent reports
// one, yet the machine starting it needs the repo to find or clone a checkout
// (a rented Mac had none of the person's folders, 2026-11-18). getProjectInfo
// names it from the owner's earlier sessions in the same folder.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

const REMOTE = "https://github.com/littlebirdai/littlebird.git";

async function conv(t: any, user: Id<"users">, fields: Record<string, unknown>) {
  return await t.run((ctx: any) => ctx.db.insert("conversations", {
    user_id: user, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
    message_count: 0, is_private: true, status: "active", ...fields,
  }));
}

test("a new session's repo comes from the owner's earlier sessions in that folder or its checkout", async () => {
  const t = convexTest(schema, allModules);
  const [me, other] = await t.run(async (ctx: any) => [
    await ctx.db.insert("users", { name: "D", email: "d@x.dev" }),
    await ctx.db.insert("users", { name: "O", email: "o@x.dev" }),
  ]);
  await conv(t, me, { project_path: "/Users/david/git/littlebird", git_root: "/Users/david/git/littlebird", git_remote_url: REMOTE, started_at: 5 });
  await conv(t, other, { project_path: "/Users/david/git/secret", git_root: "/Users/david/git/secret", git_remote_url: "https://github.com/o/secret.git" });
  const fresh = await conv(t, me, { project_path: "/Users/david/git/littlebird" });
  const sub = await conv(t, me, { project_path: "/Users/david/git/littlebird/backend" });
  const elsewhere = await conv(t, me, { project_path: "/Users/david/git/secret" });
  const home = await conv(t, me, { project_path: "/Users/david" });
  const as = t.withIdentity({ subject: `${me}|session` });
  const info = (id: Id<"conversations">) => as.query(api.conversations.getProjectInfo, { conversation_id: id });

  expect(await info(fresh)).toMatchObject({ git_root: "/Users/david/git/littlebird", git_remote_url: REMOTE });
  expect(await info(sub)).toMatchObject({ project_path: "/Users/david/git/littlebird/backend", git_root: "/Users/david/git/littlebird", git_remote_url: REMOTE });
  expect(await info(elsewhere)).toMatchObject({ git_root: null, git_remote_url: null });
  expect(await info(home)).toMatchObject({ git_remote_url: null });
});
