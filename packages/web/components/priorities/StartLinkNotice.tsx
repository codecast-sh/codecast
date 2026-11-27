// The new-session composer opened from a milestone's Start, before Send: when
// the session would not land where its priority is (lib/priorityStartLink
// startLinkForecast), one line saying so, and where sharing would fix it, one
// press that shares a summary with the priority's team. The person presses it;
// nothing is shared by default.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { lookup } from "../../lib/liveEntities";
import { startLinkForecast, type StartDestination } from "../../lib/priorityStartLink";
import { TOUCH_AREA } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { isConvexId, useInboxStore } from "../../store/inboxStore";

const api = _api as any;

export function StartLinkNotice({ conversationId }: { conversationId: string }) {
  const sig = useInboxStore((st) => {
    const row: any = st.sessions[conversationId];
    const priority: string = row?._start?.priority ?? "";
    const workspace = priority ? (lookup(st.priorities as Record<string, any>, priority) as { workspace?: string } | undefined)?.workspace ?? "" : "";
    return [priority, workspace, row?._visibility ?? "", row?._team === "team" ? "1" : "", row?.git_root || row?.project_path || ""].join("\u0001");
  });
  const [priority, workspace, picked, team, path] = sig.split("\u0001");
  // The same args as the visibility picker's (NewSessionVisibilityPicker): one subscription.
  const destination = useQueryNoThrow(api.sessionVisibilityPreview.creationTeam, priority ? { path: path || undefined, priority } : "skip").data as StartDestination;
  if (!priority || isConvexId(conversationId)) return null;
  const forecast = startLinkForecast(workspace || undefined, destination, { visibility: picked || undefined, team: !!team });
  if (!forecast) return null;
  const words = forecast.kind === "folder"
    ? `This folder belongs to ${forecast.team}: not on ${priority}`
    : forecast.kind === "locked" ? `This folder is private: not on ${priority}` : `Private: not on ${priority}`;
  return (
    <span data-start-link-notice={forecast.kind} className="inline-flex min-w-0 items-center gap-2 text-meta text-sol-text-dim">
      <span className="truncate">{words}</span>
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
