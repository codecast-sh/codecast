import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";
import { X, Users, ArrowRight } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";

const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000;

export function TeamSharingBanner() {
  const dismissedTs = useInboxStore(
    (s) => s.clientState.dismissed?.team_sharing_prompt ?? 0,
  );
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();

  const user = useQuery(api.users.getCurrentUser);
  const mappings = useQuery(api.users.getDirectoryTeamMappings);

  useMountEffect(() => {
    setMounted(true);
  });

  const isDismissed =
    dismissedTs > 0 && Date.now() - dismissedTs < DISMISS_DURATION_MS;

  if (!mounted || isDismissed) return null;
  if (user === undefined || mappings === undefined) return null;

  // Only show if user belongs to a team
  const activeTeamId = user?.active_team_id || user?.team_id;
  if (!activeTeamId) return null;

  // Check if user has any auto_share mappings for their active team
  const hasSharedProjects = mappings?.some(
    (m: { team_id: string; auto_share: boolean }) =>
      m.team_id === activeTeamId && m.auto_share,
  );
  if (hasSharedProjects) return null;

  const handleSetup = () => {
    router.push(
      `/settings/sync?teamSetup=1&teamId=${activeTeamId}`,
    );
  };

  return (
    <div className="bg-gradient-to-r from-sol-cyan/10 via-sol-blue/10 to-sol-cyan/10 border-b border-sol-cyan/30">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Users className="w-4 h-4 text-sol-cyan flex-shrink-0" />
          <span className="text-sm text-sol-text truncate">
            Share projects with your team so teammates can see what you're
            working on
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={handleSetup}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-sol-cyan/20 hover:bg-sol-cyan/30 text-sol-cyan rounded transition-colors"
          >
            Set up sharing
            <ArrowRight className="w-3 h-3" />
          </button>
          <button
            onClick={() =>
              updateDismissed("team_sharing_prompt", Date.now())
            }
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
