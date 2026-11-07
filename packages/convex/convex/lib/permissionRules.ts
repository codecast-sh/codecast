// The server half of codecast's permission rules (shared/contracts
// permissionRules.ts has the parsing and matching). A rule belongs to the
// person whose sessions it settles, and applies inside one project (the
// repository, so its worktrees and clones share it) and one workspace (the
// team the session works in, or the person's own: a rule kept in a team's
// session does not settle their personal work, nor the reverse). The
// workspace is the session's team, not its visibility, so making a session
// private keeps the rules it works under.
// Only its owner reads or removes it: an approval governs commands on the
// owner's own machines, and nobody else's answer may widen that.
import type { Doc } from "../_generated/dataModel";
import { isUnattendedConversation } from "@codecast/shared/contracts";
import {
  evaluatePermission,
  permissionRuleLabel,
  type PermissionRule,
  type PermissionRuleRequest,
} from "@codecast/shared/contracts/permissionRules";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";

export { ruleRequestValidator } from "./permissionRuleRequest";

type ConvLike = Pick<Doc<"conversations">, "_id" | "user_id" | "team_id" | "git_remote_url" | "git_root" | "project_path">;

/** The project a conversation's rules live under: its repository (owner/name,
 *  the key every clone and worktree share), else its checkout path. */
export function permissionProjectKey(conv: Pick<ConvLike, "git_remote_url" | "git_root" | "project_path">): string {
  return repositoryKeyOfRemote(conv.git_remote_url) || conv.git_root || conv.project_path || "";
}

/** The workspace a conversation's rules live under. Scope, not access: the
 *  rule is read by its owner alone. */
export function permissionScopeKey(conv: Pick<ConvLike, "user_id" | "team_id">): string {
  return conv.team_id ? `team:${conv.team_id}` : `user:${conv.user_id}`;
}

type Ctx = { db: any };

export async function rulesForConversation(ctx: Ctx, conv: ConvLike): Promise<Doc<"permission_rules">[]> {
  // No repository and no path: no project to hold rules, so none apply.
  if (!permissionProjectKey(conv)) return [];
  const scope = permissionScopeKey(conv);
  const rows: Doc<"permission_rules">[] = await ctx.db
    .query("permission_rules")
    .withIndex("by_user_project", (q: any) => q.eq("user_id", conv.user_id).eq("project", permissionProjectKey(conv)))
    .collect();
  return rows.filter((r) => r.scope === scope);
}

export type Settlement =
  | { action: "allow"; reason: "rule" }
  | { action: "deny"; reason: "rule" | "unattended"; message: string }
  | { action: "ask" };

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** How a call settles before anyone is asked. A configured deny wins; a call
 *  every pattern of which is allowed passes; in a session nobody watches, an
 *  uncovered call is denied with what the agent can do instead; otherwise a
 *  person is asked. */
export function settle(
  conv: Parameters<typeof isUnattendedConversation>[0],
  request: PermissionRuleRequest,
  rules: readonly PermissionRule[],
): Settlement {
  const verdict = evaluatePermission(request, rules);
  if (verdict.action === "deny") {
    return {
      action: "deny",
      reason: "rule",
      message: `Codecast is set never to allow ${code(permissionRuleLabel(verdict.rule))} in this project, so ${code(verdict.pattern)} was not run. Do the work another way, or leave this step to a person.`,
    };
  }
  if (verdict.action === "allow") return { action: "allow", reason: "rule" };
  if (isUnattendedConversation(conv)) {
    const what = verdict.uncovered.length ? verdict.uncovered.map(code).join(", ") : "this call";
    return {
      action: "deny",
      reason: "unattended",
      message: `Nobody is watching this session to approve it, and no saved codecast approval covers ${what}, so it was denied. Reach the goal without it if you can. If it is truly needed, ask a person through \`cast decide\` and wait for the answer, or report it as blocked.`,
    };
  }
  return { action: "ask" };
}

/** Keeps an "always" answer: one allow rule per pattern, skipping ones already kept. */
export async function saveAllowRules(
  ctx: Ctx,
  conv: ConvLike,
  request: Pick<PermissionRuleRequest, "permission" | "always">,
): Promise<Doc<"permission_rules">[]> {
  const existing = await rulesForConversation(ctx, conv);
  const saved: Doc<"permission_rules">[] = [];
  const now = Date.now();
  for (const pattern of new Set(request.always)) {
    if (existing.some((r) => r.permission === request.permission && r.pattern === pattern && r.action === "allow")) continue;
    const row = {
      user_id: conv.user_id,
      project: permissionProjectKey(conv),
      scope: permissionScopeKey(conv),
      permission: request.permission,
      pattern,
      action: "allow" as const,
      created_at: now,
      source_conversation_id: conv._id,
    };
    const id = await ctx.db.insert("permission_rules", row);
    saved.push({ _id: id, _creationTime: now, ...row } as Doc<"permission_rules">);
  }
  return saved;
}
