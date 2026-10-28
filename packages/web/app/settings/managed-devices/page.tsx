"use client";

// Settings › Managed devices: the active team's MDM setup, its enrolled Macs
// and the policy they carry (components/settings/ManagedDevicesEditor). Team
// admins only; the nav shows the section to no one else.
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../../../store/inboxStore";
import { ManagedDevicesPanel } from "../../../components/settings/ManagedDevicesEditor";

export default function ManagedDevicesPage() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const team = useInboxStore((s) => s.teams.find((t) => t?._id === activeTeamId));
  if (!activeTeamId || team?.role !== "admin") {
    return <p className="mx-auto max-w-3xl px-1 text-sm text-sol-text-muted">Switch to a team you administer to manage its devices.</p>;
  }
  return <ManagedDevicesPanel teamId={activeTeamId} teamName={team.name} />;
}
