import React, { type ReactNode } from "react";

export function SessionWorktreeChip({ name, branch, preparing, moving, hostName, hostIcon }: {
  name?: string | null;
  branch?: string | null;
  preparing?: boolean;
  /** A bulk migration is moving this session between machines (Settings → Migration). */
  moving?: boolean;
  hostName?: string;
  hostIcon?: ReactNode;
}) {
  if (!name && !preparing && !moving) return null;
  const title = [
    hostName && `Runs on ${hostName}`,
    moving
      ? "Moving to another machine — messages sent now wait and arrive after the move."
      : preparing ? "Preparing the cloud host — its worktree is being made now." : `Worktree ${name}${branch ? ` (${branch})` : ""}`,
  ].filter(Boolean).join("\n");
  const busy = preparing || moving;
  return (
    <span
      className={`inline-flex min-w-0 text-[9px] font-mono max-w-[130px] ${busy ? "text-sol-violet animate-pulse" : "text-sol-cyan"}`}
      title={title}
    >
      <span className="sr-only">{title}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1 min-w-0">
        {hostIcon}
        <span className="truncate">{moving ? "moving" : preparing ? "preparing" : name}</span>
      </span>
    </span>
  );
}
