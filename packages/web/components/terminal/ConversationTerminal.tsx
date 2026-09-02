"use client";

// Per-conversation terminal split: a live view of the agent's tmux pane docked
// between the message feed and the composer — scoped to ONE conversation,
// unlike the global bottom panel. Backed by the same terminal registry (a
// `detached` instance: no panel tab), so theme and lifecycle are shared.
//
// TWO TRANSPORTS, chosen by where the pane actually lives:
//
//   this machine   → the loopback PTY WebSocket. Interactive, byte-exact.
//   your other box → screens relayed through Convex (lib/terminal/remotePane).
//   an agent box   → the same relay, authorized by the session you own there
//                    (a bot account's daemon runs it; devices.ts decides).
//                    A few frames a second, and typing works at that same
//                    speed: fine for answering an agent, wrong for vim.
//   someone else's → nothing. Relaying it would mean writing commands into
//                    another account's daemon queue; we name the machine and
//                    stop there.
//
// The pane's machine is known up front (devices.getConversationMachine), so the
// choice needs no guessing: discovery is asked about that ONE device, and a
// miss means the pane is elsewhere — the relay's cue, not an error.
//
// Open state and heights live at module level keyed by conversation, so
// switching conversations and back preserves the split (and its xterm buffer)
// without touching inboxStore — same reasoning as termSessions.ts.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { X, RotateCw, Radio } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { deviceDisplayName } from "../DeviceBadge";
import type { SessionMachine } from "../tmuxAttach";
import { getTerminalEndpoint } from "../../lib/terminal/endpoint";
import {
  attachToContainer,
  closeTab,
  getInstance,
  getTerminalsVersion,
  openTerminal,
  subscribeTerminals,
} from "../../lib/terminal/termSessions";
import { ConnectingNote } from "./TerminalPanel";
import { SplitResizeHandle } from "../SplitResizeHandle";
import {
  conversationTerminalSplits as splits,
  bumpConversationTerminals as bump,
  subscribeConversationTerminals as subscribe,
  getConversationTerminalsVersion as getVersion,
  toggleConversationTerminal,
  type SplitState,
} from "../../lib/terminal/conversationTerminalState";

const MIN_HEIGHT = 90;
// Comfortably more than the daemon's heartbeat, so a slow round-trip doesn't
// flicker the "paused" label on and off.
const STALE_AFTER_MS = 12_000;

export function ConversationTerminalSplit({ convKey, tmuxSession }: { convKey: string; tmuxSession?: string | null }) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const split = splits.get(convKey);
  if (!split) return null;
  return <SplitBody convKey={convKey} split={split} tmuxSession={tmuxSession ?? null} />;
}

function SplitBody({ convKey, split, tmuxSession }: { convKey: string; split: SplitState; tmuxSession: string | null }) {
  useSyncExternalStore(subscribeTerminals, getTerminalsVersion, getTerminalsVersion);
  const convex = useConvex();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const connecting = useRef(false);

  // The pane can move on session restart (tmux_session changes) — follow it.
  const target = tmuxSession ?? split.target;

  // Which machine owns the pane. An enrichment, so it goes through
  // useQueryNoThrow: if it never answers we fall back to plain local discovery,
  // which is exactly the old behaviour.
  const machineQuery = useQueryNoThrow(
    api.devices.getConversationMachine,
    convKey ? ({ conversation_id: convKey as any } as any) : "skip",
  );
  const machine = machineQuery.data as SessionMachine | null | undefined;
  // "Settled" covers the error case too: if the lookup never answers we still
  // want to try the local daemon rather than sit on a spinner forever.
  const machineSettled = machine !== undefined || !!machineQuery.error;
  const machineName = machine ? deviceDisplayName(machine as any) : null;
  const foreign = !!machine && !machine.is_mine;

  const connect = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    setFailure(null);
    try {
      // A teammate's machine: their daemon, their account's command queue.
      // Naming it is the honest answer.
      if (foreign) {
        setFailure(
          `This pane runs on ${machineName ?? "another person's machine"}, which only its owner can stream.`,
        );
        return;
      }

      // Ask only the machine that owns the pane. When the pane's machine is
      // unknown we keep the old broadcast lookup. An agent box answers under a
      // bot account's daemon, which no loopback socket of ours can be — skip
      // the discovery and go straight to the relay.
      const endpoint = machine?.via_bot
        ? null
        : await getTerminalEndpoint(convex, { deviceId: machine?.device_id });
      const current = splits.get(convKey);
      if (!current) return;

      if (endpoint) {
        current.termId = openTerminal({
          endpoint,
          kind: "attach",
          target,
          title: target,
          detached: true,
          // Interactive, same as a manual `tmux attach` — the pill is just the
          // safe version of it (ignore-size, no nesting).
          interactive: true,
        });
      } else if (machine?.device_id) {
        // The pane is on another of YOUR machines, or on an agent box running
        // a session you own. No socket can reach it, so watch it through the
        // relay instead; the conversation is what authorizes the agent-box case.
        current.termId = openTerminal({
          remote: { convex, deviceId: machine.device_id, target, conversationId: convKey },
          kind: "attach",
          target,
          title: target,
          detached: true,
        });
      } else {
        setFailure("No local daemon reachable — the agent runs on another machine or cast isn't running here.");
        return;
      }
      current.target = target;
      bump();
    } finally {
      connecting.current = false;
    }
  }, [convex, convKey, target, machine?.device_id, machine?.via_bot, foreign, machineName]);

  useEffect(() => {
    // Wait for the machine lookup: connecting before it lands would broadcast
    // to every device and then have to tear the wrong transport back down.
    if (!machineSettled) return;
    const current = splits.get(convKey);
    if (!current) return;
    const inst = current.termId ? getInstance(current.termId) : null;
    // (Re)connect when nothing is live yet, or the pane moved under us.
    if (!inst || (current.target !== target && target)) {
      if (inst && current.target !== target) {
        closeTab(current.termId!);
        current.termId = null;
      }
      if (target) void connect();
    }
  }, [convKey, target, connect, machineSettled]);

  const inst = split.termId ? getInstance(split.termId) : null;
  const status = inst?.state.status;
  // No instance yet means the endpoint is still resolving — that's loading too.
  const isConnecting = !failure && (!status || status === "connecting");
  const isRemote = !!inst?.state.remote;
  // A relayed pane that stops sending is the one failure the socket path can't
  // have: the picture stays perfectly readable while being minutes old. Frames
  // arrive on a heartbeat even when the screen doesn't change, so silence means
  // the far machine went away — say so rather than let a stale screen pass for
  // live.
  //
  // Going stale is time passing, not a state change, so it needs its own tick
  // — a frame that never arrives re-renders nothing on its own.
  const lastFrameAt = inst?.state.lastFrameAt ?? 0;
  const now = useCoarseNow(2000);
  const stale = isRemote && status === "open" && lastFrameAt > 0 && now - lastFrameAt > STALE_AFTER_MS;

  useEffect(() => {
    if (split.termId && containerRef.current && status === "open") {
      attachToContainer(split.termId, containerRef.current);
    }
  }, [split.termId, status]);

  const reconnect = useCallback(() => {
    const current = splits.get(convKey);
    if (current?.termId) {
      closeTab(current.termId);
      current.termId = null;
    }
    void connect();
  }, [convKey, connect]);

  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = split.height;
    const maxH = Math.round(window.innerHeight * 0.7);
    let latest = startHeight;
    const onMove = (ev: PointerEvent) => {
      // Top-docked: dragging DOWN grows the split.
      latest = Math.min(Math.max(startHeight + (ev.clientY - startY), MIN_HEIGHT), maxH);
      setDragHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      split.height = latest;
      setDragHeight(null);
      bump();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };

  const close = () => toggleConversationTerminal(convKey, target);

  return (
    <div
      data-terminal-panel
      className="flex-shrink-0 flex flex-col bg-sol-bg"
      style={{ height: dragHeight ?? split.height }}
    >
      <div className="flex items-center h-[24px] px-2 gap-1.5 flex-shrink-0 bg-sol-bg-alt/30 border-b border-sol-border/20 select-none">
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            status === "open" ? "bg-sol-violet" : isConnecting ? "bg-sol-yellow animate-pulse" : "bg-sol-text-dim/40"
          }`}
        />
        <span className="text-[10px] font-mono text-sol-text-muted truncate">{target}</span>
        {isRemote && (
          <span
            className="inline-flex items-center gap-1 px-1 rounded text-[9px] font-mono text-sol-cyan bg-sol-cyan/10 flex-shrink-0"
            title={`Relayed from ${machineName ?? "another machine"}. Typing works, but every keystroke makes a round trip — expect a moment before it shows up.`}
          >
            <Radio className="w-2.5 h-2.5" />
            {machineName ?? "remote"}
          </span>
        )}
        {stale && (
          <span className="text-[9px] font-mono text-sol-yellow flex-shrink-0" title="No frames for a while — the machine may be asleep or offline.">
            paused
          </span>
        )}
        <span className="flex-1" />
        {(status === "exited" || status === "error" || status === "offline" || failure) && (
          <button
            onClick={reconnect}
            title="Reconnect"
            className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-cyan transition-colors"
          >
            <RotateCw className="w-3 h-3" />
          </button>
        )}
        <button onClick={close} title="Close terminal view" className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-text-muted transition-colors">
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        {failure || status === "offline" || status === "exited" || status === "error" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[11px] font-mono text-center px-6">
            <span>
              {failure ? (
                <span className="text-sol-text-dim">{failure}</span>
              ) : status === "offline" ? (
                <>
                  <span className="text-sol-yellow">no connection</span>
                  <span className="text-sol-text-dim"> — the terminal needs the daemon reachable on this machine</span>
                </>
              ) : status === "error" ? (
                <span className="text-sol-red">{inst?.state.statusDetail ?? "could not attach to the tmux session"}</span>
              ) : (
                <span className="text-sol-text-dim">{inst?.state.statusDetail ?? "session ended"}</span>
              )}
            </span>
            <button
              onClick={reconnect}
              className="px-2 py-0.5 rounded border border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors"
            >
              Reconnect
            </button>
          </div>
        ) : isConnecting ? (
          <ConnectingNote
            label={
              machine && !machine.is_mine
                ? `Attaching to ${target}…`
                : machine?.device_id
                  ? `Finding ${target} on ${machineName ?? "its machine"}…`
                  : `Attaching to ${target}…`
            }
          />
        ) : null}
        <div
          ref={containerRef}
          className={`absolute inset-0 overflow-auto pl-2 pt-1 ${status === "open" ? "" : "invisible"}`}
        />
      </div>

      <SplitResizeHandle onPointerDown={onHandlePointerDown} title="Drag to resize" />
    </div>
  );
}
