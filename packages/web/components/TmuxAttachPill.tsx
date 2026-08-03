"use client";

/**
 * Header pill for the session's tmux attach target. The target is stateful —
 * it appears when the daemon places the agent in a pane, changes name when a
 * restart lands the session in a new pane, and goes stale when the daemon
 * disconnects — so the pill shows that state instead of a static icon: a live
 * dot while connected, dimmed colors when not, a gentle entrance when the pane
 * comes up, and a one-shot glow when the name changes.
 *
 * A pane exists on exactly ONE machine, and it is routinely not the machine the
 * browser is on — a session owned by a teammate's box, or by your own Linux
 * server. So what the pill copies depends on where the pane lives:
 *
 *   your machine, ssh_host set   → ssh <host> -t "tmux attach -t '<pane>'"
 *   your machine, no ssh_host    → tmux attach -t '<pane>'   (+ a nudge to set one)
 *   someone else's machine       → the machine's name, not copyable at all
 *
 * The last case is the point: `tmux attach` for a pane on another host is not a
 * command that can ever work, and handing it over as if it could is what made
 * this pill actively misleading.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useConvex, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { SquareTerminal } from "lucide-react";
import { copyToClipboard } from "../lib/utils";
import { openAgentTerminal } from "../lib/terminal/openAttach";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { DeviceDot, deviceDisplayName } from "./DeviceBadge";
import { attachCommand, type SessionMachine } from "./tmuxAttach";

export function TmuxAttachPill({
  tmuxSession,
  isLive,
  conversationId,
}: {
  tmuxSession?: string | null;
  isLive: boolean;
  conversationId?: string | null;
}) {
  // undefined = first render: never animate what was already there on mount.
  const prev = useRef<string | null | undefined>(undefined);
  const [anim, setAnim] = useState<"tmux-pill-in" | "tmux-pill-change" | null>(null);
  const [opening, setOpening] = useState(false);
  const convex = useConvex();

  const machine = useQuery(
    api.devices.getConversationMachine,
    tmuxSession && conversationId ? { conversation_id: conversationId as any } : "skip",
  ) as SessionMachine | null | undefined;

  const openInPanel = async () => {
    if (!tmuxSession || opening) return;
    setOpening(true);
    try {
      const res = await openAgentTerminal(convex, tmuxSession);
      if (!res.ok) toast.error(res.reason ?? "Couldn't open terminal");
    } finally {
      setOpening(false);
    }
  };

  useEffect(() => {
    const p = prev.current;
    prev.current = tmuxSession ?? null;
    if (p === undefined) return;
    if (!p && tmuxSession) setAnim("tmux-pill-in"); // pane came up
    else if (p && tmuxSession && p !== tmuxSession) setAnim("tmux-pill-change"); // restart moved it
  }, [tmuxSession]);

  if (!tmuxSession) return null;

  const attach = attachCommand(tmuxSession, machine);
  const machineName = machine ? deviceDisplayName(machine as any) : null;
  const foreign = !!machine && !machine.is_mine;

  // The pane is on a machine that isn't yours: name it, don't pretend it's
  // reachable. The terminal-panel button still works — it routes through the
  // owning daemon rather than through the viewer's shell.
  const label = foreign
    ? `Runs on ${machineName} — not your machine, so there's no attach command to copy. Use the terminal panel →`
    : attach && machine?.ssh_host
      ? `Copy ${attach}`
      : attach && machine
        ? `Copy ${attach} — set an SSH host for ${machineName} in Settings → Devices to get a remote-ready command`
        : `Copy ${attach}`;

  const onCopy = () => {
    if (!attach) return;
    copyToClipboard(attach)
      .then(() => toast.success(machine?.ssh_host ? "ssh + tmux attach copied" : "tmux attach copied"))
      .catch(() => toast.error("Failed to copy"));
  };

  const pillColors = isLive
    ? "bg-sol-green/10 text-sol-green border-sol-green/30 hover:bg-sol-green/20"
    : "bg-gray-500/10 text-gray-400 border-gray-500/25 hover:bg-gray-500/20";
  return (
    <span className={`inline-flex items-stretch rounded border overflow-hidden ${isLive ? "border-sol-green/30" : "border-gray-500/25"} ${anim ?? ""}`} onAnimationEnd={() => setAnim(null)}>
      <ShortcutTooltip label={isLive ? label : `${label} — session not connected`} side="bottom">
        {/* aria-disabled, NOT disabled: a truly disabled button suppresses the
            pointer events the tooltip needs, and in the foreign-machine case
            that tooltip is the entire explanation for why nothing copies. */}
        <button
          onClick={onCopy}
          aria-disabled={!attach}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-colors border-0 ${pillColors} ${attach ? "" : "cursor-default"}`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          {/* Naming the machine is what makes the pill honest at a glance — the
              old bare "tmux" read as "here" no matter where the pane was. */}
          {foreign ? machineName : "tmux"}
          <DeviceDot online={isLive} />
        </button>
      </ShortcutTooltip>
      {isLive && (
        <ShortcutTooltip label="Watch this agent's terminal in the panel (read-only)" side="bottom">
          <button
            onClick={openInPanel}
            className={`inline-flex items-center px-1 py-0.5 text-[10px] transition-colors border-0 border-l ${isLive ? "border-l-sol-green/30" : "border-l-gray-500/25"} ${pillColors} ${opening ? "opacity-50" : ""}`}
            aria-label="Open agent terminal in panel"
          >
            <SquareTerminal className="w-3 h-3" />
          </button>
        </ShortcutTooltip>
      )}
    </span>
  );
}
