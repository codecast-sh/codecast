"use client";
// "Make this a role" on a session (docs/architecture/org-roles-run-work.md R2):
// a long running session is a role that has not been named, and a person can
// name one the analyzer left out. This is the hire form with the seat filled
// in: the name is the session's title, the area is the project the session
// works in, and the create seats this session instead of starting a new one.
import { useMemo } from "react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import type { ProjectItem } from "../../store/inboxStore";
import type { OrgRoleSeat } from "@codecast/shared/contracts/orgProposal";
import { HireRoleDialog } from "./HireRoleDialog";

/** A session this old may already be a role (the analyzer's own age rule). */
export const MAKE_ROLE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type SessionRow = { _id?: string; short_id?: string; title?: string; started_at?: number; created_at?: number; project_path?: string; parent_conversation_id?: string; is_subagent?: boolean; org_role_id?: string; is_anchor?: boolean; anchor_id?: string; standing_role_id?: string };

/** Whether the ownership menu offers "Make this a role": an old enough top
 *  level session that is not a role's standing session and reports to no role
 *  (the server refuses to seat a session that already reports to one). */
export function sessionFitsARole(row: SessionRow | undefined, now: number): boolean {
  if (!row || row.is_subagent || row.parent_conversation_id || row.org_role_id || row.is_anchor || row.anchor_id || row.standing_role_id) return false;
  const started = row.started_at ?? row.created_at;
  return !!started && now - started >= MAKE_ROLE_MIN_AGE_MS;
}

/** The seat a session offers, read once from the store when the person asks:
 *  its title, its age, and the sessions it started that the store holds. */
export function seatOfSession(conversationId: string): { seat: OrgRoleSeat; project_path?: string } | null {
  const s = useInboxStore.getState() as any;
  const live = s.resolveLiveSessionId?.(conversationId) ?? conversationId;
  const row: SessionRow | undefined = s.sessions?.[live] ?? s.conversations?.[conversationId];
  if (!row) return null;
  const ids = new Set([conversationId, live, row._id].filter(Boolean));
  const helpers = Object.values(s.sessions ?? {}).filter((c: any) => c?.parent_conversation_id && ids.has(c.parent_conversation_id)).length;
  return {
    seat: { existing: row.short_id ?? conversationId, ...(row.title ? { title: row.title } : {}), ...(row.started_at ?? row.created_at ? { started_at: row.started_at ?? row.created_at } : {}), ...(helpers ? { helpers } : {}) },
    project_path: row.project_path,
  };
}

export function MakeRoleDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  // The hire form reads the chart for handles and parents; feed it while open.
  useSyncOrgTreeFeeder();
  const tree = useInboxStore((s) => s.orgTree);
  const meId = useInboxStore((s) => (s.currentUser as any)?._id as string | undefined) ?? "";
  const offered = useMemo(() => seatOfSession(conversationId), [conversationId]);
  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const home = useMemo(() => projects.filter((p) => offered?.project_path && (p as { project_path?: string }).project_path === offered.project_path), [projects, offered]);
  if (!tree || !offered) return null;
  return (
    <HireRoleDialog
      key={`${conversationId}:${home.map((p) => p._id).join(",")}`}
      open
      onClose={onClose}
      tree={tree}
      meId={meId}
      title="Make this a role"
      submitLabel="Name it"
      seat={offered.seat}
      initial={{ name: offered.seat.title }}
      initialProjects={home}
      onCreate={({ touched: _touched, ...input }) => {
        useInboxStore.getState().createOrgRole(input);
        toast.success(`${input.name} is now a role. The session keeps running as it was.`);
        onClose();
      }}
    />
  );
}
