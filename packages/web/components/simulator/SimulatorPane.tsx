"use client";
// The iOS simulator an agent session holds, live beside its conversation:
// what the device shows, touchable, with the hardware buttons a finger cannot
// reach on a screen.
//
// The stream is BrowserStream's with source "sim" (the daemon's simulator
// engine, packages/cli sim/watch.ts): the same socket, relay and agent cursor
// as a watched browser tab. This file is the pane around it: one 32px header
// in the house panel language, carrying the device's name, whether it is
// live, Home and Lock, and the pane's own close and expand.

import { useCallback, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Circle, Lock, RotateCw, Smartphone } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useInboxStore } from "../../store/inboxStore";
import { useTabActive } from "../../hooks/usePagePresence";
import { useTabContext } from "../../lib/tabParams";
import { stageClose, stageExpand } from "../../lib/stage";
import { deviceDisplayName } from "../DeviceBadge";
import type { SessionMachine } from "../tmuxAttach";
import type { BrowserStreamReport, SimButton, WatchInputEvent } from "../../lib/browserWatch";
import { BrowserStream } from "../browser/BrowserStream";
import { PaneControls } from "../stage/PaneControls";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";

const BUTTONS: { button: SimButton; label: string; icon: React.ReactNode }[] = [
  { button: "home", label: "Home", icon: <Circle className="w-3 h-3" /> },
  { button: "lock", label: "Lock", icon: <Lock className="w-3 h-3" /> },
];

export function SimulatorPane() {
  const ctx = useTabContext();
  const sessionUuid = ctx?.searchParams.get("s") || "";
  const leafId = ctx?.leafId;

  // The session's conversation and tmux name are already in the store; a
  // scalar read keeps the churny sessions collection from re-rendering this.
  const session = useInboxStore(
    useShallow((s) => {
      const row = sessionUuid
        ? (s.sessions[sessionUuid] ?? Object.values(s.sessions).find((r) => r.session_id === sessionUuid))
        : undefined;
      return { convId: row?._id ?? null, tmuxSession: row?.tmux_session ?? null, title: row?.title ?? null };
    }),
  );

  // Which machine holds the device. Enrichment (the header-outage rule):
  // without an answer the stream still tries this machine's daemon.
  const machineQuery = useQueryNoThrow(
    api.devices.getConversationMachine,
    session.convId ? ({ conversation_id: session.convId as any } as any) : "skip",
  );
  const machine = machineQuery.data as SessionMachine | null | undefined;
  const machineSettled = !session.convId || machine !== undefined || !!machineQuery.error;
  const machineName = machine ? deviceDisplayName(machine as any) : null;

  const tabActive = useTabActive();
  const [report, setReport] = useState<BrowserStreamReport>({
    status: { kind: "connecting" },
    tab: null,
    controlAvailable: false,
    hasFrame: false,
    nav: null,
  });
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const send = useRef<((events: WatchInputEvent[]) => void) | null>(null);

  const status = report.status;
  const live = status.kind === "live";
  const failed = status.kind === "failed" ? status : null;
  const canTouch = live && report.controlAvailable;
  const deviceName = report.tab?.title || "Simulator";
  const where = useMemo(() => (machineName ? `on ${machineName}` : null), [machineName]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-sol-bg" data-simulator-pane>
      <div className="cc-panel__head">
        <span className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden text-meta font-mono">
          <span className="cc-panel__icon">
            <Smartphone className="w-3 h-3" />
          </span>
          <span className="flex-shrink-0 truncate text-sol-text-muted">{deviceName}</span>
          <span
            data-simulator-status={status.kind}
            className={`flex-shrink-0 inline-flex items-center gap-1 tracking-wider ${live ? "text-sol-red" : "text-sol-text-dim"}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${live ? "bg-sol-red" : status.kind === "connecting" ? "bg-sol-yellow" : "bg-sol-text-dim/40"}`}
            />
            {live ? "LIVE" : status.kind === "connecting" ? "CONNECTING" : status.kind === "paused" ? "PAUSED" : "OFF"}
          </span>
          {where && <span className="min-w-0 truncate text-sol-text-dim/70">{where}</span>}
        </span>
        {BUTTONS.map((b) => (
          <ShortcutTooltip key={b.button} label={`${b.label} button`}>
            <button
              type="button"
              className="cc-panel__btn"
              aria-label={`${b.label} button`}
              disabled={!canTouch}
              onClick={() => send.current?.([{ kind: "button", button: b.button }])}
            >
              {b.icon}
            </button>
          </ShortcutTooltip>
        ))}
        {failed?.canRetry && (
          <ShortcutTooltip label="Reconnect">
            <button type="button" className="cc-panel__btn" aria-label="Reconnect" onClick={reconnect}>
              <RotateCw className="w-3 h-3" />
            </button>
          </ShortcutTooltip>
        )}
        {leafId && <PaneControls onExpand={() => stageExpand(leafId)} onClose={() => stageClose(leafId)} />}
      </div>

      <div className="relative flex-1 min-h-0 bg-sol-bg-inset">
        {sessionUuid ? (
          <BrowserStream
            source="sim"
            inputRef={send}
            sessionUuid={sessionUuid}
            tmuxSession={session.tmuxSession}
            machine={machine ?? null}
            machineSettled={machineSettled}
            paneActive={tabActive}
            control
            reloadToken={attempt}
            onState={setReport}
          />
        ) : null}
        {!sessionUuid ? (
          <Overlay message="No session named" />
        ) : failed ? (
          <Overlay message={failed.message} action={failed.canRetry ? { label: failed.capped ? "Resume" : "Reconnect", onClick: reconnect } : undefined} />
        ) : status.kind === "connecting" && !report.hasFrame ? (
          <Overlay message="Connecting to the simulator" />
        ) : null}
      </div>
    </div>
  );
}

function Overlay({ message, action }: { message: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-meta font-mono bg-sol-bg/80">
      <span className="text-sol-text-dim" data-simulator-message>{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="px-2 py-0.5 rounded border border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
