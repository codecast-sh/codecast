"use client";

/**
 * Header pill for the session's tmux attach target. The target is stateful —
 * it appears when the daemon places the agent in a pane, changes name when a
 * restart lands the session in a new pane, and goes stale when the daemon
 * disconnects — so the pill shows that state instead of a static icon: a live
 * dot while connected, dimmed colors when not, a gentle entrance when the pane
 * comes up, and a one-shot glow when the name changes.
 *
 * Click opens a live read-only terminal view of the pane, split into THIS
 * conversation (ConversationTerminalSplit) — the copy-attach-command escape
 * hatch is the small secondary button.
 *
 * A pane exists on exactly ONE machine, and it is routinely not the machine the
 * browser is on — a session owned by a teammate's box, or by your own Linux
 * server. So what the copy button offers depends on where the pane lives:
 *
 *   your machine, ssh_host set   → ssh <host> -t "tmux attach -t '<pane>'"
 *   your machine, no ssh_host    → tmux attach -t '<pane>'   (+ a nudge to set one)
 *   someone else's machine       → the machine's name, not copyable at all
 *
 * "Your machine" includes an agent box: a machine whose daemon signs in as a
 * bot account on your team, running a session you own (devices.ts decides,
 * server-side). The last case is the point: `tmux attach` for a pane on
 * another host is not a command that can ever work, and handing it over as if
 * it could is what made this pill actively misleading.
 *
 * What the SPLIT can show follows the same three cases, because a pane can only
 * be relayed by the daemon that owns it. Your own machines work either way — a
 * local pane over the loopback PTY, a pane on your Mac mini as relayed screens.
 * Both accept typing; the relayed one just answers more slowly. A teammate's
 * pane is theirs alone.
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { Copy } from "lucide-react";
import { copyToClipboard } from "../lib/utils";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { DeviceDot, deviceDisplayName } from "./DeviceBadge";
import { attachCopy, type SessionMachine } from "./tmuxAttach";
import {
  isConversationTerminalOpen,
  toggleConversationTerminal,
} from "../lib/terminal/conversationTerminalState";

import { useWatchEffect } from "../hooks/useWatchEffect";
/**
 * The machine a pane lives on, and the copy gesture for it. One hook so every
 * surface that offers "copy the attach command" — the header pill and the
 * simple-view menu — copies the same command and explains it the same way.
 */
export function useAttachCopy(tmuxSession: string | null | undefined, conversationKey: string | undefined) {
  // useQueryNoThrow, not useQuery: this lookup only ENRICHES the pill (it names
  // the machine and shapes the copy command). Without it the pill still renders
  // something honest. A plain useQuery re-throws during render, and this exact
  // query taking the whole conversation header down is why the rule exists.
  const machine = useQueryNoThrow(
    api.devices.getConversationMachine,
    tmuxSession && conversationKey ? { conversation_id: conversationKey as any } : "skip",
  ).data as SessionMachine | null | undefined;
  const copy = tmuxSession ? attachCopy(tmuxSession, machine) : null;
  const command = copy?.command ?? null;
  const message = copy?.message ?? "";
  const copyAttach = useCallback(() => {
    if (!message) return;
    // Nothing to copy is still an answer: say where the pane is and how to
    // bring it here, rather than swallowing the click.
    if (!command) {
      toast.info(message);
      return;
    }
    copyToClipboard(command)
      .then(() => toast.success(message))
      .catch(() => toast.error("Failed to copy"));
  }, [command, message]);
  return { machine, attach: command, copyAttach };
}

export function TmuxAttachPill({
  tmuxSession,
  isLive,
  conversationKey,
}: {
  tmuxSession?: string | null;
  isLive: boolean;
  /** Enables open-as-split and the machine lookup; without it the pill falls back to copy-only. */
  conversationKey?: string;
}) {
  // undefined = first render: never animate what was already there on mount.
  const prev = useRef<string | null | undefined>(undefined);
  const [anim, setAnim] = useState<"tmux-pill-in" | "tmux-pill-change" | null>(null);

  const { machine, attach, copyAttach } = useAttachCopy(tmuxSession, conversationKey);

  useWatchEffect(() => {
    const p = prev.current;
    prev.current = tmuxSession ?? null;
    if (p === undefined) return;
    if (!p && tmuxSession) setAnim("tmux-pill-in"); // pane came up
    else if (p && tmuxSession && p !== tmuxSession) setAnim("tmux-pill-change"); // restart moved it
  }, [tmuxSession]);

  if (!tmuxSession) return null;

  const machineName = machine ? deviceDisplayName(machine as any) : null;
  const foreign = !!machine && !machine.is_mine;

  // The pane is on a machine that isn't yours: name it, don't pretend it's
  // reachable — not by ssh, and not by the split either, since relaying a pane
  // means asking its owner's daemon.
  const copyLabel = foreign
    ? `Runs on ${machineName} — someone else's machine, so there's nothing here to copy or watch.`
    : attach && machine?.ssh_host
      ? `Copy ${attach}`
      : attach && machine
        ? `Copy ${attach} — valid in a shell on ${machineName}; set an SSH host for it in Settings → Devices to get a remote-ready command`
        : `Copy ${attach}`;
  // Attachability is NOT is_connected: that flag is a liveness heuristic
  // (agent heartbeat + 10-minute recency) that goes false on any quiet
  // session while its tmux pane is still perfectly alive. If we know a pane
  // name, offer the split — the daemon verifies has-session on connect and
  // the split shows a clean reconnect state if the pane is truly gone. The
  // dot keeps showing the liveness hint.
  // A teammate's pane has no transport at all, so don't offer the split for it
  // — clicking through to an explanation is worse than the tooltip saying it.
  const canSplit = !!conversationKey && !!tmuxSession && !foreign;
  const splitOpen = !!conversationKey && isConversationTerminalOpen(conversationKey);

  const pillColors = isLive
    ? "bg-sol-green/10 text-sol-green border-sol-green/30 hover:bg-sol-green/20"
    : "bg-gray-500/10 text-gray-400 border-gray-500/25 hover:bg-gray-500/20";
  const borderColor = isLive ? "border-sol-green/30" : "border-gray-500/25";

  return (
    <span className={`inline-flex items-stretch rounded-full border overflow-hidden ${borderColor} ${anim ?? ""}`} onAnimationEnd={() => setAnim(null)}>
      <ShortcutTooltip
        label={
          canSplit
            ? splitOpen
              ? "Hide this agent's terminal"
              : "Watch this agent's terminal (opens above the conversation)"
            : copyLabel
        }
        side="bottom"
      >
        <button
          onClick={() => {
            if (canSplit) toggleConversationTerminal(conversationKey!, tmuxSession);
            else copyAttach();
          }}
          className={`inline-flex items-center gap-1 pl-2 pr-1.5 py-0.5 text-[10px] font-medium transition-colors border-0 ${pillColors} ${splitOpen ? "bg-sol-green/25" : ""}`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          {/* Naming the machine is what makes the pill honest at a glance — a
              bare "tmux" reads as "here" no matter where the pane really is. */}
          {foreign ? machineName : "tmux"}
          <DeviceDot online={isLive} />
        </button>
      </ShortcutTooltip>
      {canSplit && (
        <ShortcutTooltip label={copyLabel} side="bottom">
          {/* aria-disabled, NOT disabled: a truly disabled button suppresses the
              pointer events the tooltip needs, and in the foreign-machine case
              that tooltip is the entire explanation for why nothing copies. */}
          <button
            data-simple-hide
            onClick={copyAttach}
            aria-disabled={!attach}
            className={`inline-flex items-center pl-1 pr-1.5 py-0.5 text-[10px] transition-colors border-0 border-l ${borderColor.replace("border-", "border-l-")} ${pillColors} ${attach ? "" : "cursor-default"}`}
            aria-label="Copy tmux attach command"
          >
            <Copy className="w-2.5 h-2.5" />
          </button>
        </ShortcutTooltip>
      )}
    </span>
  );
}
