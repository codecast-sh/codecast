"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

function BellIcon({ filled, className }: { filled: boolean; className: string }) {
  return (
    <svg className={className} fill={filled ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
    </svg>
  );
}

export function WatchButton({
  entityType,
  entityId,
  variant = "chip",
}: {
  entityType: "task" | "doc" | "plan" | "conversation";
  entityId: string;
  /** "chip" renders the standalone pill; "menuItem" a full-width dropdown row. */
  variant?: "chip" | "menuItem";
}) {
  const isWatching = useQuery(
    (api as any).notifications.isWatching,
    entityId ? { entity_type: entityType, entity_id: entityId } : "skip"
  );
  const toggleWatch = useMutation((api as any).notifications.toggleWatch);
  const title = isWatching ? "Watching — click to unwatch" : "Watch for notifications";

  if (variant === "menuItem") {
    return (
      <button
        onClick={() => {
          if (entityId) toggleWatch({ entity_type: entityType, entity_id: entityId });
        }}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors hover:bg-sol-bg-alt ${
          isWatching ? "text-sol-yellow" : "text-sol-text-muted"
        }`}
        title={title}
      >
        <BellIcon filled={!!isWatching} className="w-3.5 h-3.5" />
        {isWatching ? "Watching" : "Watch"}
      </button>
    );
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (entityId) toggleWatch({ entity_type: entityType, entity_id: entityId });
      }}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors text-xs ${
        isWatching
          ? "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/30 hover:bg-sol-yellow/20"
          : "bg-transparent text-sol-text-dim border-sol-border hover:text-sol-text hover:border-sol-text-dim"
      }`}
      title={title}
    >
      <BellIcon filled={!!isWatching} className="w-3 h-3" />
      {isWatching ? "Watching" : "Watch"}
    </button>
  );
}
