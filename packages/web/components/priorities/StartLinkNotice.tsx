// The new-session composer opened from a milestone's Start, before Send: when
// the session would not land where its priority is (lib/priorityStartLink
// startLinkForecast), one line saying so, and where sharing would fix it, one
// press that shares a summary with the priority's team. The person presses it;
// nothing is shared by default. When it lands on a team other than the active
// one, one line says which.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { priorityWorkspaceIn } from "../../lib/priorityStartFolder";
import { startLinkForecast, type StartDestination } from "../../lib/priorityStartLink";
import { TOUCH_AREA } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { isConvexId, useInboxStore } from "../../store/inboxStore";

const api = _api as any;

export function StartLinkNotice({ conversationId }: { conversationId: string }) {
  const sig = useInboxStore((st) => {
    const row: any = st.sessions[conversationId];
    const priority: string = row?._start?.priority ?? "";
    const workspace = priority ? priorityWorkspaceIn(st as any, priority) ?? "" : "";
    return [priority, workspace, row?._visibility ?? "", row?._team === "team" ? "1" : "", row?.git_root || row?.project_path || "", activeTeamIdOf(st) ?? ""].join("\u0001");
  });
  const [priority, workspace, picked, team, path, activeTeam] = sig.split("\u0001");
  // The same args as the visibility picker's (NewSessionVisibilityPicker): one subscription.
  const destination = useQueryNoThrow(api.sessionVisibilityPreview.creationTeam, priority ? { path: path || undefined, priority } : "skip").data as StartDestination;
  if (!priority || isConvexId(conversationId)) return null;
  const forecast = startLinkForecast(workspace || undefined, destination, { visibility: picked || undefined, team: !!team });
  if (!forecast) {
    if (!destination || workspace !== `team:${destination.team_id}` || destination.team_id === activeTeam) return null;
    return <span data-start-link-notice="shared" className="truncate text-meta text-sol-text-dim">Shared with {destination.team_name} · on {priority}</span>;
  }
  const words = forecast.kind === "folder"
    ? `This folder belongs to ${forecast.team}: not on ${priority}`
    : forecast.kind === "locked" ? `This folder is private: not on ${priority}` : `Private: not on ${priority}`;
  return (
    // On a narrow composer the words keep their line and the button wraps under them, never squeezing them to an ellipsis.
    <span data-start-link-notice={forecast.kind} className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-sol-text-dim">
      <span data-start-link-words className="min-w-0 whitespace-normal break-words">{words}</span>
      {forecast.kind === "private" && (
        <button
          type="button"
          data-start-share
          onClick={() => useInboxStore.getState().setStubVisibility(conversationId, "summary")}
          className={cn("shrink-0 rounded-control border border-sol-border px-2 py-0.5 text-meta font-medium text-sol-text hover:bg-sol-bg-alt", TOUCH_AREA)}
        >
          Share summary with {forecast.team}
        </button>
      )}
    </span>
  );
}
