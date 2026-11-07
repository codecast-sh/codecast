// Saved approvals and denies (permission_rules): feeder + reader for
// Settings > Approvals. The rows are the viewer's own, never a workspace's,
// so the reader is a plain collection read.
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

export interface PermissionRuleRow {
  _id: string;
  project: string;
  scope: string;
  permission: string;
  pattern: string;
  action: "allow" | "deny";
  label: string;
  created_at: number;
}

const ruleSig = (r: any) => `${r.project}|${r.scope}|${r.label}|${r.action}`;
const newestFirst = (a: PermissionRuleRow, b: PermissionRuleRow) => b.created_at - a.created_at;

/** The viewer's rules, newest first; `ready` once the server has answered. */
export function usePermissionRules(): { rules: PermissionRuleRow[]; ready: boolean } {
  const { ready } = useSyncCollection("permissionRules", api.permissionRules.list, {});
  const rules = useCollectionRows<PermissionRuleRow>("permissionRules", { sig: ruleSig, sort: newestFirst });
  return { rules, ready };
}
