"use client";
import { Pin } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { isPinned, togglePin } from "../../lib/sidebarPins";
import { cn } from "../../lib/utils";

/** Pins a project to the top of the sidebar, or drops it. Pressed is pinned. */
export function ProjectPinButton({ projectId, title, className }: { projectId: string; title: string; className?: string }) {
  const pinned = useInboxStore((s) => isPinned(s, "project", projectId));
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
      title={pinned ? "Unpin from the sidebar" : "Pin to the sidebar"}
      onClick={(e) => { e.stopPropagation(); togglePin("project", projectId, title); }}
      data-project-pin={pinned ? "on" : "off"}
      className={cn(
        "inline-flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0 transition-colors",
        pinned ? "text-sol-cyan hover:bg-sol-bg-alt/60" : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60",
        className,
      )}
    >
      <Pin className={cn("w-3 h-3", pinned && "fill-current")} />
    </button>
  );
}
