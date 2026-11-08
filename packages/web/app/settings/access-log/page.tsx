"use client";

// Settings › Access log: the active team's audit log of data access
// (components/settings/AccessLogPanel). Admins of a team with regulated mode
// on only; the nav shows the section to no one else.
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../../../store/inboxStore";
import { AccessLogPanel, useActiveTeamLogsAccess } from "../../../components/settings/AccessLogPanel";

export default function AccessLogPage() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const allowed = useActiveTeamLogsAccess();
  if (!activeTeamId || !allowed) {
    return <p className="mx-auto max-w-3xl px-1 text-sm text-sol-text-muted">Switch to a regulated team you administer to see its access log.</p>;
  }
  return <AccessLogPanel teamId={activeTeamId} />;
}
