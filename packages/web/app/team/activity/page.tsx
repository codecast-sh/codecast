import { useMutation } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useInboxStore } from "../../../store/inboxStore";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { ActivityPage } from "../../../components/activity/ActivityPage";
// The Activity page (the former /dashboard folded in here), in every style
// (components/activity). It's driven entirely by the URL so the
// sidebar/command-palette/team-avatar links and tab routing all share one
// source of truth:
//   ?filter=my  → your personal feed; otherwise the team feed (teamless users
//                 always get the personal feed since there's no team to show).
//   ?dir=<path> → scope the feed to a single workspace (sidebar "Workspaces").
// The page reads the rest of its view (grouping, people, project, needs) from
// the address too (components/activity/activityView).
export default function TeamActivityPage() {
  const searchParams = useSearchParams();
  // The store's copy (local-first): a warm cache paints the feed at once,
  // and offline it still paints.
  const { user } = useCurrentUser();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamId = activeTeamId || user?.active_team_id || user?.team_id;

  const mode: "personal" | "team" =
    searchParams.get("filter") === "my" || !teamId ? "personal" : "team";

  // Reading the team feed is what clears the sidebar Feed badge
  // (getTeamUnreadCount counts teammate activity past this mark). Stamp it on
  // entry and again on exit so activity that landed while the feed was open is
  // not re-counted.
  const markTeamSeen = useMutation(api.conversations.markTeamConversationsSeen);
  useWatchEffect(() => {
    if (mode !== "team") return;
    void markTeamSeen({});
    return () => { void markTeamSeen({}); };
  }, [mode, teamId, markTeamSeen]);

  return <DashboardLayout><ActivityPage tab="activity" /></DashboardLayout>;
}
