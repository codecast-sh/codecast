"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

export function WatchButton({
  entityType,
  entityId,
}: {
  entityType: "task" | "doc" | "plan" | "conversation";
  entityId: string;
}) {
  const isWatching = useQuery((api as any).notifications.isWatching, {
    entity_type: entityType,
    entity_id: entityId,
  });
  const toggleWatch = useMutation((api as any).notifications.toggleWatch);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleWatch({ entity_type: entityType, entity_id: entityId });
      }}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors text-xs ${
        isWatching
          ? "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/30 hover:bg-sol-yellow/20"
          : "bg-transparent text-sol-text-dim border-sol-border hover:text-sol-text hover:border-sol-text-dim"
      }`}
      title={isWatching ? "Watching — click to unwatch" : "Watch for notifications"}
    >
      <svg className="w-3 h-3" fill={isWatching ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
      {isWatching ? "Watching" : "Watch"}
    </button>
  );
}
