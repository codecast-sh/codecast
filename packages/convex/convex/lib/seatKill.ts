// A role's own session is never killed by a bare kill (org-staffing.md S16):
// the seat would sit empty while its triggers keep firing and its sessions keep
// reporting to it. Every explicit kill door asks this first; the retire path
// decommissions the seat itself and passes `retiring`.
export async function refuseSeatKill(ctx: { db: any }, conv: any): Promise<void> {
  if (!conv?.standing_role_id) return;
  const role = await ctx.db.get(conv.standing_role_id);
  if (!role || role.status === "retired") return;
  throw new Error(`That is @${role.handle}'s own session. Killing it would leave the role with nobody doing its work; retire the role instead (cast role retire @${role.handle}, or its page), or talk the change over with the Head of People.`);
}
