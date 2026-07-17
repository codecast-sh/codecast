"use client";

/**
 * Header pill for the session's tmux attach target. The target is stateful —
 * it appears when the daemon places the agent in a pane, changes name when a
 * restart lands the session in a new pane, and goes stale when the daemon
 * disconnects — so the pill shows that state instead of a static icon: a live
 * dot while connected, dimmed colors when not, a gentle entrance when the pane
 * comes up, and a one-shot glow when the name changes. Click copies
 * `tmux attach -t '<name>'`.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { DeviceDot } from "./DeviceBadge";

export function TmuxAttachPill({ tmuxSession, isLive }: { tmuxSession?: string | null; isLive: boolean }) {
  // undefined = first render: never animate what was already there on mount.
  const prev = useRef<string | null | undefined>(undefined);
  const [anim, setAnim] = useState<"tmux-pill-in" | "tmux-pill-change" | null>(null);

  useEffect(() => {
    const p = prev.current;
    prev.current = tmuxSession ?? null;
    if (p === undefined) return;
    if (!p && tmuxSession) setAnim("tmux-pill-in"); // pane came up
    else if (p && tmuxSession && p !== tmuxSession) setAnim("tmux-pill-change"); // restart moved it
  }, [tmuxSession]);

  if (!tmuxSession) return null;

  const attach = `tmux attach -t '${tmuxSession}'`;
  return (
    <ShortcutTooltip label={isLive ? `Copy ${attach}` : `Copy ${attach} — session not connected`} side="bottom">
      <button
        onClick={() => { copyToClipboard(attach).then(() => toast.success("tmux attach copied")).catch(() => toast.error("Failed to copy")); }}
        onAnimationEnd={() => setAnim(null)}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
          isLive
            ? "bg-sol-green/10 text-sol-green border-sol-green/30 hover:bg-sol-green/20"
            : "bg-gray-500/10 text-gray-400 border-gray-500/25 hover:bg-gray-500/20"
        } ${anim ?? ""}`}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        tmux
        <DeviceDot online={isLive} />
      </button>
    </ShortcutTooltip>
  );
}
