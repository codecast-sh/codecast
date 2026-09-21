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
import { HireRoleDialog } from "./HireRoleDialog";
import { seatOfSession } from "../../lib/makeRole";

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
        toast.success(`${input.name} is now a role`, { description: "The session keeps running as it was." });
        onClose();
      }}
    />
  );
}
