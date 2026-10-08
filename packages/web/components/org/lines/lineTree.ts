// The org tree as the lines read it, under one wake signature (cohesive build
// spec D13, D14). The tree carries live session state and re-pushes often, so
// the company document, a hover card, a sheet's head and a map card all
// subscribe to the facts their lines draw rather than to the tree itself.
import { useMemo } from "react";
import { orgRolesSig } from "../../../hooks/useOrgRoles";
import { useInboxStore } from "../../../store/inboxStore";
import type { OrgTree } from "../orgTypes";

/** What a line reads off the org tree: names, charters, who reports to whom,
 *  a role's standing seat, the state words it draws (a role's declared
 *  status, the session counts, a person's presence) and which sessions are
 *  live where. A session's own churn (its title, its last message) is not in
 *  it, so a message repaints no line. */
export function lineTreeSig(tree: OrgTree | null | undefined): string {
  if (!tree) return "";
  const counts = (c: Record<string, number> | undefined) => (c ? Object.values(c).join(",") : "");
  // Which sessions are live and where: a sheet's Now and its people on a project read them.
  const sessions = (list: readonly { _id: string; state: string; project_path?: string | null }[]) => list.map((x) => `${x._id}:${x.state}:${x.project_path ?? ""}`).join(",");
  let sig = orgRolesSig(tree);
  for (const r of tree.roles) sig += `\n#${r._id}|${r.charter ?? ""}|${r.status}|${r.host_user_id}|${r.created_at}|${r.scope.project_ids.join(",")}|${r.standing?.conversation_id ?? ""}|${r.standing?.state ?? ""}|${r.standing?.state_status ?? ""}|${r.standing?.state_line ?? ""}|${counts(r.counts)}|${sessions(r.sessions)}`;
  for (const p of tree.people) sig += `\n&${p.user_id}|${p.name}|${p.image ?? ""}|${p.is_me ? 1 : 0}|${p.role}|${p.presence ?? ""}|${counts(p.counts)}|${sessions(p.sessions)}`;
  return sig;
}

/** The org tree, repainting only when something a line draws changed. */
export function useLineTree(): OrgTree | null {
  const sig = useInboxStore((s) => lineTreeSig(s.orgTree));
  return useMemo(() => useInboxStore.getState().orgTree ?? null, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
}
