// Codecast-owned permission rules: a call is settled before a card exists
// (saved approvals, configured denies, unattended sessions), "always" keeps a
// rule from the arity table, and one answer settles the session's other asks.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { shellRequest, claudeToolRequest } from "@codecast/shared/contracts/permissionRules";
import schema from "./schema";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./permissions.ts": () => import("./permissions"),
  "./permissionRules.ts": () => import("./permissionRules"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "o@x", name: "Owner", last_heartbeat: Date.now() } as any);
    const other = await ctx.db.insert("users", { email: "p@x", name: "Other" } as any);
    const team = await ctx.db.insert("teams", { name: "T", created_at: 1 } as any);
    const base = { user_id: owner, is_private: true, title: "x", created_at: 1, updated_at: 1, git_remote_url: "git@github.com:Acme/App.git", git_root: "/src/app" };
    const conv = await ctx.db.insert("conversations", { ...base, session_id: "s1" } as any);
    // A worktree of the same repository: same project.
    const worktree = await ctx.db.insert("conversations", { ...base, session_id: "s2", git_root: "/wt/app-x", git_remote_url: "https://github.com/acme/app" } as any);
    const teamConv = await ctx.db.insert("conversations", { ...base, session_id: "s3", is_private: false, team_id: team, team_visibility: "full" } as any);
    const unattended = await ctx.db.insert("conversations", { ...base, session_id: "s4", unattended: true } as any);
    const otherRepo = await ctx.db.insert("conversations", { ...base, session_id: "s5", git_remote_url: "git@github.com:acme/other.git" } as any);
    return { owner, other, conv, worktree, teamConv, unattended, otherRepo };
  });
  const { api } = await import("./_generated/api");
  const asOwner = t.withIdentity({ subject: `${ids.owner}|x` } as any);
  const asOther = t.withIdentity({ subject: `${ids.other}|x` } as any);
  const create = (conv: any, command: string, session = "s1") =>
    asOwner.mutation(api.permissions.createPermissionRequest, {
      conversation_id: conv, session_id: session, tool_name: "Bash", arguments_preview: command, rule_request: shellRequest(command),
    });
  const check = (conv: any, request: any, who = asOwner) => who.query(api.permissionRules.check, { conversation_id: conv, request });
  const get = (id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;
  const rules = () => asOwner.query(api.permissionRules.list, {});
  return { t, ids, api, asOwner, asOther, create, check, get, rules };
}

test("a private session inside a team keeps its team's rules", async () => {
  const { api, ids, t, asOwner, check } = await setup();
  const id = await t.run((ctx) => ctx.db.insert("pending_permissions", {
    conversation_id: ids.teamConv, session_id: "s3", tool_name: "Bash", arguments_preview: "git push", status: "pending", created_at: Date.now(), owner_user_id: ids.owner, rule_request: shellRequest("git push"),
  } as any));
  await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: id, status: "approved", remember: true });
  await t.run((ctx) => ctx.db.patch(ids.teamConv, { is_private: true } as any));
  expect((await check(ids.teamConv, shellRequest("git push"))).action).toBe("allow");
  expect((await check(ids.conv, shellRequest("git push"))).action).toBe("ask");
});

describe("rules added by hand", () => {
  test("a deny added in Settings wins, and only a member may add to a team's scope", async () => {
    const { api, ids, asOwner, asOther, check, rules } = await setup();
    const row = { project: "acme/app", scope: `user:${ids.owner}`, permission: "bash", pattern: "git push *", action: "deny" as const };
    await asOwner.mutation(api.permissionRules.add, row);
    await asOwner.mutation(api.permissionRules.add, row);
    expect((await rules()).length).toBe(1);
    expect((await check(ids.conv, shellRequest("git push origin main"))).action).toBe("deny");
    await expect(asOther.mutation(api.permissionRules.add, { ...row, scope: `user:${ids.owner}` })).rejects.toThrow();
  });
});

describe("always allow", () => {
  test("keeps the arity pattern and settles the next call before any card", async () => {
    const { api, ids, asOwner, create, check, rules } = await setup();
    expect((await check(ids.conv, shellRequest("git push origin main"))).action).toBe("ask");
    const id = await create(ids.conv, "git push origin main");
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: id, status: "approved", remember: true });
    expect((await rules()).map((r: any) => r.label)).toEqual(["git push *"]);
    expect((await check(ids.conv, shellRequest("git push origin feature"))).action).toBe("allow");
    // A worktree of the same repo shares it; another repo and the team workspace do not.
    expect((await check(ids.worktree, shellRequest("git push"))).action).toBe("allow");
    expect((await check(ids.otherRepo, shellRequest("git push"))).action).toBe("ask");
    expect((await check(ids.teamConv, shellRequest("git push"))).action).toBe("ask");
    // Every sub-command must be covered.
    expect((await check(ids.conv, shellRequest("git push && rm -rf x"))).action).toBe("ask");
  });

  test("a rule applies to Codex calls too: the request is harness-neutral", async () => {
    const { api, ids, asOwner, check } = await setup();
    const id = await asOwner.mutation(api.permissions.createPermissionRequest, {
      conversation_id: ids.conv, session_id: "s1", tool_name: "Write", arguments_preview: "/src/app/a.ts", rule_request: claudeToolRequest("Write", { file_path: "/src/app/a.ts" }, { root: "/src/app" }),
    });
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: id, status: "approved", remember: true });
    expect((await check(ids.conv, { permission: "edit", patterns: ["/src/app/b.ts"], always: ["/src/app/*"] })).action).toBe("allow");
    expect((await check(ids.conv, { permission: "edit", patterns: ["/Users/o/.zshrc"], always: [] })).action).toBe("ask");
  });

  test("an opaque call keeps nothing", async () => {
    const { api, ids, asOwner, create, get, rules } = await setup();
    const id = await create(ids.conv, "echo $(whoami)");
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: id, status: "approved", remember: true });
    expect((await get(id)).remember).toBeUndefined();
    expect(await rules()).toEqual([]);
  });

  test("re-checks the session's other pending asks and approves the ones now covered", async () => {
    const { api, ids, asOwner, create, get } = await setup();
    const first = await create(ids.conv, "npm run build");
    const covered = await create(ids.conv, "npm run build -- --prod");
    const uncovered = await create(ids.conv, "npm run deploy");
    const otherSession = await create(ids.worktree, "npm run build", "s2");
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: first, status: "approved", remember: true });
    expect((await get(covered)).status).toBe("approved");
    expect((await get(uncovered)).status).toBe("pending");
    expect((await get(otherSession)).status).toBe("pending");
    const responded = await asOwner.query(api.permissions.getAllRespondedPermissions, { user_id: String(ids.owner) });
    expect(responded.map((p: any) => p._id).sort()).toEqual([first, covered].sort());
  });

  test("a rule is its owner's alone", async () => {
    const { api, ids, asOwner, asOther, create, check, rules } = await setup();
    const id = await create(ids.conv, "git push");
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: id, status: "approved", remember: true });
    expect(await asOther.query(api.permissionRules.list, {})).toEqual([]);
    expect((await check(ids.conv, shellRequest("git push"), asOther)).action).toBe("ask");
    const [rule] = await rules();
    await expect(asOther.mutation(api.permissionRules.remove, { rule_id: rule._id })).rejects.toThrow();
    await asOwner.mutation(api.permissionRules.remove, { rule_id: rule._id });
    expect(await rules()).toEqual([]);
    expect((await check(ids.conv, shellRequest("git push"))).action).toBe("ask");
  });
});

describe("denials", () => {
  test("a denial with feedback denies the session's other pending asks with it", async () => {
    const { api, ids, asOwner, create, get } = await setup();
    const a = await create(ids.conv, "rm -rf dist");
    const b = await create(ids.conv, "rm -rf build");
    const elsewhere = await create(ids.worktree, "rm -rf x", "s2");
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: a, status: "denied", message: "clean with bun run clean" });
    expect(await get(b)).toMatchObject({ status: "denied", deny_message: "clean with bun run clean" });
    expect((await get(elsewhere)).status).toBe("pending");
  });

  test("a bare denial settles only its own row", async () => {
    const { api, ids, asOwner, create, get } = await setup();
    const a = await create(ids.conv, "rm a");
    const b = await create(ids.conv, "rm b");
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: a, status: "denied" });
    expect((await get(b)).status).toBe("pending");
  });

  test("a configured deny wins over a saved approval, attended or not", async () => {
    const { t, ids, check } = await setup();
    await t.run(async (ctx) => {
      const row = { user_id: ids.owner, project: "acme/app", scope: `user:${ids.owner}`, permission: "bash", created_at: 1 };
      await ctx.db.insert("permission_rules", { ...row, pattern: "git *", action: "allow" } as any);
      await ctx.db.insert("permission_rules", { ...row, pattern: "git push *", action: "deny" } as any);
    });
    const attended = await check(ids.conv, shellRequest("git push --force"));
    expect(attended.action).toBe("deny");
    expect(attended.message).toContain("git push *");
    expect((await check(ids.conv, shellRequest("git status"))).action).toBe("allow");
    expect((await check(ids.unattended, shellRequest("git push"))).action).toBe("deny");
  });
});

describe("unattended sessions", () => {
  test("an uncovered ask is denied at once with a message the agent can act on", async () => {
    const { ids, check } = await setup();
    const r = await check(ids.unattended, shellRequest("cd /src/app && git push origin main", { cwd: "/src/app/x", root: "/src/app" }));
    expect(r.action).toBe("deny");
    expect(r.reason).toBe("unattended");
    expect(r.message).toContain("`git push origin main`");
    expect(r.message).toContain("cast decide");
  });

  test("a call its owner's saved approvals cover is allowed", async () => {
    const { api, ids, asOwner, create, check } = await setup();
    const id = await create(ids.conv, "bun test");
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: id, status: "approved", remember: true });
    expect((await check(ids.unattended, shellRequest("bun test x.test.ts"))).action).toBe("allow");
  });

  test("a call with no rule terms (seen only in the status) is denied, not left waiting", async () => {
    const { ids, check } = await setup();
    const r = await check(ids.unattended, { permission: "bash", patterns: [], always: [], opaque: true });
    expect(r).toMatchObject({ action: "deny", reason: "unattended" });
  });

  test("an attended session with no rule asks", async () => {
    const { ids, check } = await setup();
    expect((await check(ids.conv, shellRequest("git push"))).action).toBe("ask");
  });
});
