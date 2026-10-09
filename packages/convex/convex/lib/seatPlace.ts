// Where a role's seat runs, and as whom. The standing session is the one home
// of both facts: the daemon rewrites its project_path when it places the
// session on a machine (the foreign path of another laptop becomes this
// machine's checkout of the same repo), and a move (cast pull, cast role move,
// cast migrate) changes its user_id and device. The role and anchor rows keep
// no copy, so a moved seat needs no second write to stay true.
//
// `host_user_id` on the role is who seated it. It answers only while no
// standing session exists, and for access (orgAccess), never for routing.
export function seatPlace(
  seat: { host_user_id: any },
  standing: { user_id: any; project_path?: string | null } | null | undefined,
): { runner_user_id: any; project_path: string | undefined } {
  return {
    runner_user_id: standing?.user_id ?? seat.host_user_id,
    project_path: standing?.project_path ?? undefined,
  };
}

/** The person who runs a role now: its standing session's runner, else who
 *  seated it. The sessions a role takes in are this person's. */
export async function roleRunner(ctx: { db: any }, role: { host_user_id: any; anchor_id?: any }): Promise<any> {
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const standing = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  return seatPlace(role, standing).runner_user_id;
}
