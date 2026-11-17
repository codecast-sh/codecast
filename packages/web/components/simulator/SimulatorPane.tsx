"use client";
// The iOS simulator an agent session holds, live beside its conversation:
// what the device shows, touchable, with the controls a finger cannot reach on
// a screen.
//
// The stream is BrowserStream's with source "sim" (the daemon's simulator
// engine, packages/cli sim/watch.ts): the same socket, relay and agent cursor
// as a watched browser tab. This file is the pane around it: one 32px header
// in the house panel language, carrying the device's name, whether it is
// live, its controls, and the pane's own close and expand. The controls take
// Simulator.app's own shortcuts while the pane has focus.

import { useCallback, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { Camera, Circle, Lock, RotateCcw, RotateCw, Smartphone, Square } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { useTabActive } from "../../hooks/usePagePresence";
import { useTabContext } from "../../lib/tabParams";
import { stageClose, stageExpand } from "../../lib/stage";
import { deviceDisplayName } from "../DeviceBadge";
import type { SessionMachine } from "../tmuxAttach";
import type { BrowserStreamReport, SimButton, SimCapture, WatchInputEvent } from "../../lib/browserWatch";
import { BrowserStream } from "../browser/BrowserStream";
import { PaneControls } from "../stage/PaneControls";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";

/** How often a pane waiting for the session's simulator asks again. */
const WAIT_RETRY_MS = 3000;

/** A base64 payload saved as a file where the browser saves downloads. */
function saveFile(name: string, mime: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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
      return { convId: row?._id ?? null, tmuxSession: row?.tmux_session ?? null };
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
  const frame = useRef<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const status = report.status;
  const live = status.kind === "live";
  const failed = status.kind === "failed" ? status : null;
  const waiting = !!failed?.waiting;
  const canTouch = live && report.controlAvailable;
  const deviceName = report.tab?.title || "Simulator";
  const device = report.device ?? null;
  // A screenshot and a recording come back whole only over this machine's
  // socket; through the relay the pane saves the frame it is showing.
  const fullCapture = canTouch && report.transport === "local" && !!device?.canCapture;
  const recording = device?.recording ?? null;
  const now = useCoarseNow(recording ? 1000 : 60_000);

  // Waiting for the agent to take a simulator is not a failure to fix by hand.
  useWatchEffect(() => {
    if (!waiting || !tabActive) return;
    const t = setTimeout(reconnect, WAIT_RETRY_MS);
    return () => clearTimeout(t);
  }, [waiting, tabActive, attempt, reconnect]);

  const press = useCallback((events: WatchInputEvent[]) => send.current?.(events), []);
  const button = useCallback((b: SimButton) => press([{ kind: "button", button: b }]), [press]);
  const rotate = useCallback((direction: "left" | "right") => press([{ kind: "rotate", direction }]), [press]);

  const screenshot = useCallback(() => {
    if (fullCapture) {
      setCapturing(true);
      press([{ kind: "capture" }]);
      return;
    }
    if (!frame.current) return;
    const at = new Date();
    saveFile(`${deviceName} ${at.toISOString().slice(0, 19).replace("T", " at ").replace(/:/g, ".")}.jpg`, "image/jpeg", frame.current.split(",")[1] ?? "");
    toast.success("Saved the screen as it shows here");
  }, [fullCapture, press, deviceName]);

  const toggleRecording = useCallback(() => {
    if (!fullCapture) return;
    press([{ kind: "record", action: recording ? "stop" : "start" }]);
  }, [fullCapture, press, recording]);

  const onCapture = useCallback((c: SimCapture) => {
    if (c.kind === "screenshot") setCapturing(false);
    if ("error" in c) {
      toast.error(c.error);
      return;
    }
    saveFile(c.name, c.mime, c.data);
    toast.success(`Saved ${c.name}`);
  }, []);

  // Simulator.app's shortcuts, while focus is in the pane (the screen takes it
  // on the first click). The browser's own meaning of these keys yields here.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!canTouch || !(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    const act =
      e.shiftKey && key === "h" ? () => button("home")
      : !e.shiftKey && key === "l" ? () => button("lock")
      : e.key === "ArrowLeft" ? () => rotate("left")
      : e.key === "ArrowRight" ? () => rotate("right")
      : !e.shiftKey && key === "s" ? screenshot
      : !e.shiftKey && key === "r" && fullCapture ? toggleRecording
      : null;
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-sol-bg" data-simulator-pane onKeyDownCapture={onKeyDown}>
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
              className={`w-1.5 h-1.5 rounded-full ${live ? "bg-sol-red" : status.kind === "connecting" || waiting ? "bg-sol-yellow" : "bg-sol-text-dim/40"}`}
            />
            {live ? "LIVE" : status.kind === "connecting" ? "CONNECTING" : status.kind === "paused" ? "PAUSED" : waiting ? "WAITING" : "OFF"}
          </span>
          {machineName && <span className="min-w-0 truncate text-sol-text-dim/70">on {machineName}</span>}
        </span>
        {recording && (
          <button
            type="button"
            data-simulator-recording
            onClick={toggleRecording}
            className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 h-5 rounded text-meta font-mono text-sol-red border border-sol-red/40 hover:bg-sol-red/10"
            aria-label="Stop recording"
          >
            <Square className="w-2.5 h-2.5 fill-current" />
            {elapsed(now - recording.since)}
          </button>
        )}
        <PaneButton label="Rotate left" accel="CmdOrCtrl+Left" disabled={!canTouch} onClick={() => rotate("left")}>
          <RotateCcw className="w-3 h-3" />
        </PaneButton>
        <PaneButton label="Rotate right" accel="CmdOrCtrl+Right" disabled={!canTouch} onClick={() => rotate("right")}>
          <RotateCw className="w-3 h-3" />
        </PaneButton>
        <PaneButton label="Home" accel="CmdOrCtrl+Shift+H" disabled={!canTouch} onClick={() => button("home")}>
          <Circle className="w-3 h-3" />
        </PaneButton>
        <PaneButton label="Lock" accel="CmdOrCtrl+L" disabled={!canTouch} onClick={() => button("lock")}>
          <Lock className="w-3 h-3" />
        </PaneButton>
        <PaneButton
          label={fullCapture ? "Save a screenshot" : "Save the screen as shown"}
          accel="CmdOrCtrl+S"
          disabled={!report.hasFrame || capturing}
          onClick={screenshot}
        >
          <Camera className="w-3 h-3" />
        </PaneButton>
        {fullCapture && !recording && (
          <PaneButton label="Record the screen" accel="CmdOrCtrl+R" onClick={toggleRecording}>
            <span className="w-2.5 h-2.5 rounded-full bg-sol-red/80" />
          </PaneButton>
        )}
        {failed?.canRetry && !waiting && (
          <PaneButton label="Reconnect" onClick={reconnect}>
            <RotateCw className="w-3 h-3" />
          </PaneButton>
        )}
        {leafId && <PaneControls onExpand={() => stageExpand(leafId)} onClose={() => stageClose(leafId)} />}
      </div>

      <div className="relative flex-1 min-h-0 bg-sol-bg-inset">
        {sessionUuid ? (
          <BrowserStream
            source="sim"
            inputRef={send}
            frameRef={frame}
            onCapture={onCapture}
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
          <Overlay
            message={waiting ? "Waiting for this session to take a simulator" : failed.message}
            action={!waiting && failed.canRetry ? { label: failed.capped ? "Resume" : "Reconnect", onClick: reconnect } : undefined}
          />
        ) : status.kind === "connecting" && !report.hasFrame ? (
          <Overlay message="Connecting to the simulator" />
        ) : null}
      </div>
    </div>
  );
}

function PaneButton({
  label,
  accel,
  disabled,
  onClick,
  children,
}: {
  label: string;
  accel?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <ShortcutTooltip label={label} accel={accel}>
      <button type="button" className="cc-panel__btn" aria-label={label} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </ShortcutTooltip>
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
