// The workspace's roles without the rest of the org tree. The `orgTree`
// singleton carries `updated_at` and `state` for the top sessions under every
// node, so a surface that only names a role (an owner chip, a chief of staff
// lookup) must not subscribe to the whole tree: every message in the
// workspace would re-render it. This subscribes to a signature of the fields
// such a surface branches on (store/wakeSig.ts) and hands back a memo-stable
// roles array. Fields outside the signature (counts, sessions, caps) can be
// stale between re-renders; a surface that renders them reads the tree.
//
// Reader only: it mounts no feeder. Mount useSyncOrgTree once on a page that
// is not guaranteed to follow the org page.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { OrgRole, OrgTree } from "../components/org/orgTypes";

export type OrgWorkspace = OrgTree["workspace"];

const NO_ROLES: OrgRole[] = [];

/** The wake signature: workspace plus, per role, what a name lookup reads. */
export function orgRolesSig(tree: OrgTree | null | undefined): string {
  if (!tree) return "";
  let sig = `${tree.workspace.kind}:${tree.workspace.id}:${tree.workspace.name}`;
  // `avatar` is in the signature because these surfaces DRAW the face (the
  // ownership menu's role list, the role pill): without it a face change lands
  // in the tree and nothing repaints.
  // The scope's projects and the parent role are in it because the project
  // lead is read from them (shared/contracts/orgLead): a role that gains a
  // project, or moves under another role, can change who leads. Both change
  // on a person's edit, never on a heartbeat. The parent is there for a person
  // too: the task board's Chain axis nests a role under whoever it reports to
  // (lib/taskChain), so a role moved from one person to another must repaint.
  for (const r of tree.roles) sig += `\n${r._id}|${r.handle}|${r.short_id}|${r.name}|${r.status}|${r.avatar ?? ""}|${r.scope.project_ids.join(",")}|${r.reports_to.kind}:${r.reports_to.kind === "role" ? r.reports_to.role_id : r.reports_to.user_id}`;
  return sig;
}

export function useOrgRoles(): { roles: OrgRole[]; workspace: OrgWorkspace | null } {
  const sig = useInboxStore((s) => orgRolesSig(s.orgTree));
  return useMemo(() => {
    const tree = useInboxStore.getState().orgTree;
    return { roles: tree?.roles ?? NO_ROLES, workspace: tree?.workspace ?? null };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
}
