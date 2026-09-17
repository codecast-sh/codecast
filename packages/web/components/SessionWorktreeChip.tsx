import React, { type ReactNode } from "react";
import { cloudSeedTitle } from "@codecast/shared/contracts";

/**
 * Where a session runs beyond its device: its worktree, the host's shared
 * checkout (`shared`), "preparing" while a laptop is still readying the
 * cloud host, or "moving" while a bulk migration carries it between
 * machines. Moving wins, then preparing; a shared row renders even with no
 * worktree name, since the main checkout has none. A placed cloud row also
 * says what it started from (`seed`): `<name> @<base7>` in the chip, the
 * "Started from …" line in the title.
 */
export function SessionWorktreeChip({ name, branch, preparing, shared, moving, hostName, hostIcon, seed }: {
  name?: string | null;
  branch?: string | null;
  preparing?: boolean;
  shared?: boolean;
  /** A bulk migration is moving this session between machines (Settings → Migration). */
  moving?: boolean;
  hostName?: string;
  hostIcon?: ReactNode;
  seed?: { source: "checkout" | "origin_main"; base: string; branch?: string | null; dirty?: boolean | null; laptop_root?: string | null; reason?: string | null } | null;
}) {
  if (!name && !preparing && !shared && !moving) return null;
  const where = moving ? "Moving to another machine — messages sent now wait and arrive after the move."
    : preparing ? "Preparing the cloud host — its checkout is being made now."
    : shared ? `Runs in the host's main checkout${branch ? ` (${branch})` : ""}`
    : `Worktree ${name}${branch ? ` (${branch})` : ""}`;
  const busy = preparing || moving;
  const started = seed && !busy ? cloudSeedTitle(seed) : "";
  const title = [hostName && `Runs on ${hostName}`, where, started].filter(Boolean).join("\n");
  const label = moving ? "moving" : preparing ? "preparing" : shared ? "shared" : name;
  const text = seed && !busy ? `${label} @${seed.base.slice(0, 7)}` : label;
  return (
    <span
      className={`inline-flex min-w-0 text-[9px] font-mono max-w-[130px] ${busy ? "text-sol-violet animate-pulse" : "text-sol-cyan"}`}
      title={title}
    >
      <span className="sr-only">{title}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1 min-w-0">
        {hostIcon}
        <span className="truncate">{text}</span>
      </span>
    </span>
  );
}
