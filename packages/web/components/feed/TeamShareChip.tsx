// The share state of one of the viewer's own sessions on the team feed, as a
// chip in the card's meta line: "Only you" while hidden, "Team · Summary" or
// "Team · Full" while shared. It opens the same Hidden / Summary / Full picker
// the session header uses, so a session is shared or taken back without
// leaving the feed. The card behind it dims while hidden (FeedCard).
import { useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { TeamShareModePicker } from "../TeamShareModePicker";
import { useTeamShareActions } from "../../hooks/useTeamShareActions";
import { useInboxStore } from "../../store/inboxStore";
import { teamVisibilityFor } from "../../lib/teamVisibility";
import { TEAM_SHARE_MODE_LABEL, teamShareState } from "../../lib/teamFeedRows";
import type { Conversation } from "../ConversationList";

/** The viewer's membership row for one team, woken only by its level, never by
 *  a teams list re-push that changed nothing the chip reads. */
function useTeamMembership(teamId: string) {
  const sig = useInboxStore((s) => {
    const t = teamVisibilityFor(s.teams, teamId) as any;
    return t ? `${t.visibility ?? ""}|${JSON.stringify(t.visibility_history ?? [])}` : "";
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the churny list
  return useMemo(() => teamVisibilityFor(useInboxStore.getState().teams, teamId), [sig, teamId]);
}

export function TeamShareChip({ conv, teamId }: { conv: Conversation; teamId: string }) {
  const membership = useTeamMembership(teamId);
  const { mode, gated } = teamShareState(conv, membership);
  const { setPrivate, shareWithTeam } = useTeamShareActions(conv._id);
  const [open, setOpen] = useState(false);
  const hidden = mode === "private";
  const sharedVia = conv.auto_shared ? (conv.git_root || conv.project_path || null) : null;
  const Icon = hidden ? EyeOff : Eye;
  const tone = hidden
    ? "text-sol-text-dim/55 hover:text-sol-yellow"
    : mode === "full"
      ? "text-emerald-600/80 dark:text-emerald-400/80 hover:text-emerald-500"
      : "text-teal-600/80 dark:text-teal-400/80 hover:text-teal-500";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          data-share-mode={mode}
          className={`inline-flex items-center gap-1 rounded px-1 py-px transition-colors hover:bg-sol-bg-alt ${tone}`}
          title={hidden ? "Hidden from the team. Click to share." : "Shared with the team. Click to change."}
          aria-label={hidden ? "Hidden from the team; change sharing" : `Shared with the team as ${TEAM_SHARE_MODE_LABEL[mode]}; change sharing`}
        >
          <Icon className="w-3 h-3" aria-hidden="true" />
          {hidden ? TEAM_SHARE_MODE_LABEL.private : `Team · ${TEAM_SHARE_MODE_LABEL[mode]}`}
        </button>
      </PopoverTrigger>
      {/* A React portal still bubbles clicks to the card, which would open the
          session; stop them here. */}
      <PopoverContent align="start" className="w-72 bg-sol-bg border-sol-border p-3" onClick={(e) => e.stopPropagation()}>
        <TeamShareModePicker
          mode={mode}
          gated={gated}
          teamId={teamId}
          sharedVia={sharedVia}
          onChange={(next) => (next === "private" ? setPrivate() : shareWithTeam(next))}
          onNavigate={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
