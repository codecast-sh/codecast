// The workspace a read names: a team (`team_id`, what older clients send) or any
// workspace key (`workspace`: `team:<id>` or `user:<id>`, the personal pages).
// Exactly one. Access is still the caller's to check (workspaceGrantsAccess).

import type { Id } from "../_generated/dataModel";

export function workspaceOfArgs(args: { team_id?: Id<"teams"> | null; workspace?: string | null }): string {
  if (!!args.team_id === !!args.workspace) throw new Error("Name a team or a workspace, exactly one");
  return args.workspace ?? `team:${args.team_id}`;
}
