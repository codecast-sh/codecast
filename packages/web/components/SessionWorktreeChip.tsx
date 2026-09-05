import React, { type ReactNode } from "react";

export function SessionWorktreeChip({ name, branch, preparing, hostName, hostIcon }: {
  name?: string | null;
  branch?: string | null;
  preparing?: boolean;
  hostName?: string;
  hostIcon?: ReactNode;
}) {
  if (!name && !preparing) return null;
  const title = [
    hostName && `Runs on ${hostName}`,
    preparing ? "Preparing the cloud host — its worktree is being made now." : `Worktree ${name}${branch ? ` (${branch})` : ""}`,
  ].filter(Boolean).join("\n");
  return (
    <span
      className={`inline-flex min-w-0 text-[9px] font-mono max-w-[130px] ${preparing ? "text-sol-violet animate-pulse" : "text-sol-cyan"}`}
      title={title}
    >
      <span className="sr-only">{title}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1 min-w-0">
        {hostIcon}
        <span className="truncate">{preparing ? "preparing" : name}</span>
      </span>
    </span>
  );
}
