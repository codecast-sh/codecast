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
  for (const r of tree.roles) sig += `\n${r._id}|${r.handle}|${r.short_id}|${r.name}|${r.status}`;
  return sig;
}

export function useOrgRoles(): { roles: OrgRole[]; workspace: OrgWorkspace | null } {
  const sig = useInboxStore((s) => orgRolesSig(s.orgTree));
  return useMemo(() => {
    const tree = useInboxStore.getState().orgTree;
    return { roles: tree?.roles ?? NO_ROLES, workspace: tree?.workspace ?? null };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
}
