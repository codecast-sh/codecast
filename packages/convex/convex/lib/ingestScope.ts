// The scope every external data function resolves (docs/architecture/external-data.md),
// and a source by the ref a person types. Out of ingest.ts because ingest.ts
// imports replays.ts, which needs these too. The args validator is in
// ingestScopeArgs.ts, a true leaf: it is spread into args when a module
// loads, and this file sits on an import cycle through data.ts.
import type { Doc, Id } from "../_generated/dataModel";
import type { ScopeArgs } from "./ingestScopeArgs";
import { createWorkContext } from "../data";
import { requireUserOrToken } from "./auth";
import { rowByRef } from "./rowByRef";
import { normalizeSourceName } from "@codecast/shared/contracts/ingest";

// `user_id` is the server acting as a person (a published page's queries run
// as their publisher): only internal functions take it, so a caller can never
// name one. Every public door resolves the caller from its session or token.
export async function scopeOf(ctx: any, args: ScopeArgs & { user_id?: Id<"users"> }) {
  const userId = args.user_id ?? (await requireUserOrToken(ctx, args.api_token));
  const { db } = await createWorkContext(ctx, {
    userId,
    workspace: args.workspace,
    team_id: args.team_id,
    project_path: args.project_path,
    conversation_id: args.conversation_id,
  });
  return { userId, db, workspaceKey: db.workspaceKey as string };
}

/** A source by short id, Convex id, or name inside the caller's workspace, if the caller may read it. */
export async function sourceByRef(ctx: any, userId: Id<"users">, workspaceKey: string, ref: string): Promise<Doc<"event_sources">> {
  return await rowByRef(ctx, "event_sources", userId, ref, "Source", (needle) =>
    ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspaceKey).eq("name", normalizeSourceName(needle))).first(),
  );
}

export { scopeArgs, type ScopeArgs } from "./ingestScopeArgs";

/**
 * The scope a source's reports are filed under: the source's own workspace
 * (its access key), never its routing team. A source routed to a team but
 * private to its owner (`team_id: T`, `workspace: user:<owner>`) files into
 * the owner's personal workspace (CLAUDE.md, Workspace access vs routing).
 */
export function sourceFilingScope(source: Pick<Doc<"event_sources">, "workspace" | "team_id">): { workspace: "team"; team_id: Id<"teams"> } | { workspace: "personal" } {
  return source.workspace.startsWith("team:") && source.team_id ? { workspace: "team", team_id: source.team_id } : { workspace: "personal" };
}
