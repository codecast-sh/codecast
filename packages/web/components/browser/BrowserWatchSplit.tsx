"use client";

// Live view of the browser tab an agent is driving, docked into the
// conversation the same way the terminal split is (ConversationTerminal.tsx),
// and reachable over the same transport: the daemon's loopback endpoint,
// discovered once via getTerminalEndpoint. Read-only — frames flow in, no
// clicks flow back. Closing the pane closes the socket, which is the daemon's
// signal to stop the screencast.
//
// Open state and heights live at module level keyed by conversation, so
// switching conversations and back preserves the split — but unlike the
// terminal (whose xterm buffer is expensive to rebuild) the stream itself is
// torn down on unmount and redialed on mount: a screencast nobody is looking
// at should not keep Chrome encoding JPEGs.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { X, RotateCw, MousePointerClick } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { deviceDisplayName } from "../DeviceBadge";
import { SplitResizeHandle } from "../SplitResizeHandle";
import type { SessionMachine } from "../tmuxAttach";
import { getTerminalEndpoint } from "../../lib/terminal/endpoint";
import {
  connectBrowserWatch,
  type WatchConnection,
  type WatchInputEvent,
  type WatchTabInfo,
} from "../../lib/browserWatch";

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;

interface SplitState {
  height: number;
}

const splits = new Map<string, SplitState>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getVersion(): number {
  return version;
}

export function isBrowserWatchOpen(convKey: string): boolean {
  return splits.has(convKey);
}

/** Reactive open-state, for affordances that toggle the split. */
export function useBrowserWatchOpen(convKey: string | undefined): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return !!convKey && splits.has(convKey);
}

export function toggleBrowserWatch(convKey: string): void {
  if (splits.has(convKey)) splits.delete(convKey);
  else splits.set(convKey, { height: DEFAULT_HEIGHT });
  bump();
}

type Status =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "failed"; message: string; canRetry: boolean };

function exitMessage(reason: string): string {
  switch (reason) {
    case "tab-closed":
      return "the agent's browser tab was closed";
    case "browser-closed":
      return "the managed browser is no longer running";
    case "timeout":
      return "stream paused after 30 minutes — reconnect to keep watching";
    default:
      return "stream ended";
  }
}

function errorMessage(code: string, message: string): string {
  switch (code) {
    case "no-browser":
      return "no managed browser is running on the agent's machine";
    case "no-tab":
      return "this session hasn't driven a browser tab yet";
    case "forbidden":
      return "the daemon refused the stream — reload to refresh the endpoint";
    default:
      return message || "could not open the stream";
  }
}

export function BrowserWatchSplit({
  convKey,
  sessionUuid,
  tmuxSession,
}: {
  convKey: string;
  sessionUuid?: string | null;
  tmuxSession?: string | null;
}) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const split = splits.get(convKey);
  if (!split) return null;
  return <SplitBody convKey={convKey} split={split} sessionUuid={sessionUuid ?? null} tmuxSession={tmuxSession ?? null} />;
}

function SplitBody({
  convKey,
  split,
  sessionUuid,
  tmuxSession,
}: {
  convKey: string;
  split: SplitState;
  sessionUuid: string | null;
  tmuxSession: string | null;
}) {
  const convex = useConvex();
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [tab, setTab] = useState<WatchTabInfo | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const connRef = useRef<WatchConnection | null>(null);
  // Control: the daemon grants it on ready; the toggle is the human's choice.
  const [controlAvailable, setControlAvailable] = useState(false);
  const [controlOn, setControlOn] = useState(false);
  // Bumped to force a reconnect; the connect effect depends on it.
  const [attempt, setAttempt] = useState(0);

  // Which machine the agent (and so its browser) lives on. Enrichment only —
  // useQueryNoThrow per the header-outage rule; without an answer we still try
  // local discovery, which is the correct behaviour on a one-machine setup.
  const machineQuery = useQueryNoThrow(
    api.devices.getConversationMachine,
    convKey ? ({ conversation_id: convKey as any } as any) : "skip",
  );
  const machine = machineQuery.data as SessionMachine | null | undefined;
  const machineSettled = machine !== undefined || !!machineQuery.error;
  const machineName = machine ? deviceDisplayName(machine as any) : null;
  const foreign = !!machine && !machine.is_mine;

  useEffect(() => {
    if (!machineSettled) return;
    let cancelled = false;
    setStatus({ kind: "connecting" });

    (async () => {
      if (foreign) {
        setStatus({
          kind: "failed",
          message: `This agent's browser runs on ${machineName ?? "someone else's machine"}, which only its owner can watch.`,
          canRetry: false,
        });
        return;
      }
      const endpoint = await getTerminalEndpoint(convex, { deviceId: machine?.device_id });
      if (cancelled) return;
      if (!endpoint) {
        setStatus({
          kind: "failed",
          message: machine?.device_id
            ? `The browser runs on ${machineName ?? "another of your machines"} — watching works from a browser on that machine.`
            : "No local daemon reachable — the watch pane needs cast running on this machine.",
          canRetry: true,
        });
        return;
      }
      connRef.current = connectBrowserWatch(
        endpoint,
        { sessionUuid, tmuxSession, control: true },
        {
          onReady(t, control) {
            if (cancelled) return;
            setTab(t);
            setControlAvailable(control);
            setStatus({ kind: "live" });
          },
          onFrame(dataUrl) {
            if (!cancelled) setFrame(dataUrl);
          },
          onTab(t) {
            if (!cancelled) setTab(t);
          },
          onError(code, message) {
            if (!cancelled) setStatus({ kind: "failed", message: errorMessage(code, message), canRetry: true });
          },
          onExit(reason) {
            if (!cancelled) setStatus({ kind: "failed", message: exitMessage(reason), canRetry: true });
          },
        },
      );
    })();

    return () => {
      cancelled = true;
      connRef.current?.close();
      connRef.current = null;
    };
  }, [convex, convKey, sessionUuid, tmuxSession, machineSettled, foreign, machine?.device_id, machineName, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const close = () => toggleBrowserWatch(convKey);
  const imgRef = useRef<HTMLImageElement | null>(null);

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

  const live = status.kind === "live";

  return (
    <div className="flex-shrink-0 flex flex-col bg-sol-bg" style={{ height: dragHeight ?? split.height }}>
      <div className="flex items-center h-[24px] px-2 gap-1.5 flex-shrink-0 bg-sol-bg-alt/30 border-b border-sol-border/20 select-none">
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            live ? "bg-sol-red animate-pulse" : status.kind === "connecting" ? "bg-sol-yellow animate-pulse" : "bg-sol-text-dim/40"
          }`}
        />
        <span className={`text-[9px] font-mono tracking-wider flex-shrink-0 ${live ? "text-sol-red" : "text-sol-text-dim"}`}>
          {live ? "LIVE" : status.kind === "connecting" ? "CONNECTING" : "OFF AIR"}
        </span>
        {tab && (
          <>
            <span className="text-[10px] font-mono text-sol-text-muted truncate">{tab.title || "untitled"}</span>
            {tab.url && (
              <span className="text-[10px] font-mono text-sol-text-dim/70 truncate" title={tab.url}>
                {tab.url}
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        {live && controlAvailable && (
          <button
            onClick={() => setControlOn((v) => !v)}
            title={
              controlOn
                ? "Stop controlling — back to watch-only"
                : "Take control: click and type into this page (for sign-ins the agent can't do)"
            }
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono tracking-wider transition-colors ${
              controlOn
                ? "bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/40"
                : "text-sol-text-dim/60 hover:text-sol-cyan border border-transparent"
            }`}
          >
            <MousePointerClick className="w-3 h-3" />
            {controlOn ? "CONTROLLING" : "CONTROL"}
          </button>
        )}
        {status.kind === "failed" && status.canRetry && (
          <button
            onClick={reconnect}
            title="Reconnect"
            className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-cyan transition-colors"
          >
            <RotateCw className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={close}
          title="Close browser view"
          className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-text-muted transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 bg-sol-bg-inset">
        {frame && (
          <img
            ref={imgRef}
            src={frame}
            alt={tab?.title ? `Live view of ${tab.title}` : "Live view of the agent's browser tab"}
            className="absolute inset-0 w-full h-full object-contain"
            draggable={false}
          />
        )}
        {live && controlOn && <ControlSurface imgRef={imgRef} connRef={connRef} />}
        {status.kind === "failed" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[11px] font-mono text-center px-6 bg-sol-bg/80">
            <span className="text-sol-text-dim">{status.message}</span>
            {status.canRetry && (
              <button
                onClick={reconnect}
                className="px-2 py-0.5 rounded border border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors"
              >
                Reconnect
              </button>
            )}
          </div>
        ) : status.kind === "connecting" && !frame ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-sol-text-dim">
            Opening a live view of the agent's browser…
          </div>
        ) : null}
      </div>

      <SplitResizeHandle onPointerDown={onHandlePointerDown} title="Drag to resize" />
    </div>
  );
}

// ── Control mode ─────────────────────────────────────────────────────────────
// A transparent layer over the frame that turns the viewer's mouse and
// keyboard into page input. The frame renders object-contain, so the video
// content sits letterboxed inside the <img> box; clicks are mapped into the
// content rect and sent NORMALIZED (0..1) — the daemon scales them by the
// page's real viewport, so neither side needs the other's pixel size.

const CDP_MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

function eventModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (
    (e.altKey ? CDP_MOD.alt : 0) |
    (e.ctrlKey ? CDP_MOD.ctrl : 0) |
    (e.metaKey ? CDP_MOD.meta : 0) |
    (e.shiftKey ? CDP_MOD.shift : 0)
  );
}

/** Keys forwarded as key events; everything printable travels as insertText. */
const FORWARDED_KEYS = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete",
  "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
  "Home", "End", "PageUp", "PageDown",
]);

function ControlSurface({
  imgRef,
  connRef,
}: {
  imgRef: React.RefObject<HTMLImageElement | null>;
  connRef: React.RefObject<WatchConnection | null>;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const lastMoveAt = useRef(0);

  // Keys should land in the page the moment control turns on, without an
  // extra "click to focus" step the user has no way to discover.
  useEffect(() => {
    surfaceRef.current?.focus();
  }, []);

  const toNorm = useCallback(
    (clientX: number, clientY: number): { nx: number; ny: number } | null => {
      const img = imgRef.current;
      if (!img) return null;
      const box = img.getBoundingClientRect();
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih || !box.width || !box.height) return null;
      // object-contain: the content rect is the image aspect fit inside the box.
      const scale = Math.min(box.width / iw, box.height / ih);
      const w = iw * scale;
      const h = ih * scale;
      const left = box.left + (box.width - w) / 2;
      const top = box.top + (box.height - h) / 2;
      const nx = (clientX - left) / w;
      const ny = (clientY - top) / h;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null; // letterbox band
      return { nx, ny };
    },
    [imgRef],
  );

  const send = useCallback(
    (events: WatchInputEvent[]) => connRef.current?.sendInput(events),
    [connRef],
  );

  const mouseButton = (b: number): "left" | "right" | "middle" => (b === 2 ? "right" : b === 1 ? "middle" : "left");

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    surfaceRef.current?.focus();
    const p = toNorm(e.clientX, e.clientY);
    if (!p) return;
    send([{ kind: "mouse", type: "mousePressed", ...p, button: mouseButton(e.button), clickCount: Math.max(1, e.detail), modifiers: eventModifiers(e) }]);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = toNorm(e.clientX, e.clientY);
    if (!p) return;
    send([{ kind: "mouse", type: "mouseReleased", ...p, button: mouseButton(e.button), clickCount: Math.max(1, e.detail), modifiers: eventModifiers(e) }]);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const now = Date.now();
    if (now - lastMoveAt.current < 33) return; // ~30/s is plenty for hover states
    lastMoveAt.current = now;
    const p = toNorm(e.clientX, e.clientY);
    if (!p) return;
    send([{ kind: "mouse", type: "mouseMoved", ...p, button: "none", modifiers: eventModifiers(e) }]);
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toNorm(e.clientX, e.clientY);
    if (!p) return;
    send([{ kind: "mouse", type: "mouseWheel", ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: eventModifiers(e) }]);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Browser-level chords (⌘L, ⌘R, ⌘W…) stay the viewer's own; forwarding
    // them would be surprising in both directions.
    if (e.metaKey || e.ctrlKey) return;
    if (FORWARDED_KEYS.has(e.key)) {
      e.preventDefault();
      const mods = eventModifiers(e);
      send([
        { kind: "key", type: "keyDown", key: e.key, code: e.code, modifiers: mods },
        { kind: "key", type: "keyUp", key: e.key, code: e.code, modifiers: mods },
      ]);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      send([{ kind: "insertText", text: e.key }]);
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    send([{ kind: "insertText", text: text.slice(0, 8192) }]);
  };

  return (
    <div
      ref={surfaceRef}
      tabIndex={0}
      role="application"
      aria-label="Controlling the agent's browser tab — clicks and typing go to the page"
      className="absolute inset-0 cursor-crosshair outline-none ring-1 ring-inset ring-sol-cyan/50 focus:ring-sol-cyan"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerMove={onPointerMove}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
