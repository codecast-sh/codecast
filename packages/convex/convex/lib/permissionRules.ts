// The server half of codecast's permission rules (shared/contracts
// permissionRules.ts has the parsing and matching). A rule belongs to the
// person whose sessions it settles, and applies inside one project (the
// repository, so its worktrees and clones share it) and one workspace (the
// workspace key the session's conversation computes, so a rule kept in a team
// session does not settle the same person's private work, nor the reverse).
// Only its owner reads or removes it: an approval governs commands on the
// owner's own machines, and nobody else's answer may widen that.
import type { Doc } from "../_generated/dataModel";
import {
  evaluatePermission,
  permissionRuleLabel,
  type PermissionRule,
  type PermissionRuleRequest,
} from "@codecast/shared/contracts/permissionRules";
import { isUnattendedConversation } from "@codecast/shared/contracts";
import { computeWorkspaceKey } from "./accessKeys";

export { ruleRequestValidator } from "./permissionRuleRequest";

type ConvLike = Pick<Doc<"conversations">, "_id" | "user_id" | "team_id" | "is_private" | "auto_shared" | "team_visibility" | "git_remote_url" | "git_root" | "project_path">;

/** A git remote as host/owner/name, whatever its spelling (ssh, https, .git). */
export function remoteKey(url: string): string | null {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The project a conversation's rules live under. */
export function permissionProjectKey(conv: Pick<ConvLike, "git_remote_url" | "git_root" | "project_path">): string {
  return (conv.git_remote_url && remoteKey(conv.git_remote_url)) || conv.git_root || conv.project_path || "";
}

/** The workspace a conversation's rules live under. */
export function permissionScopeKey(conv: ConvLike): string {
  return computeWorkspaceKey({ user_id: conv.user_id, team_id: conv.team_id }, conv);
}

type Ctx = { db: any };

export async function rulesForConversation(ctx: Ctx, conv: ConvLike): Promise<Doc<"permission_rules">[]> {
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
