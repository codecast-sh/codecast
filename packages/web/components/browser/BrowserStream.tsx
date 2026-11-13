"use client";

// The live picture of the tab an agent is driving: one socket, one <img>, and
// the option to click and type into it.
//
// This is the transport and the pixels, nothing else. It has no idea whether
// it is docked over a conversation (BrowserWatchSplit) or filling a stage pane
// (backends/StreamBackend) — a host gives it the session and the machine that
// session runs on, and gets back one report (`onState`) it can draw any chrome
// it likes from. That is what lets the two hosts look completely different
// while every honest sentence about the stream is written once, in
// lib/browserWatch.
//
// The socket is dropped whenever nobody is looking. A screencast costs the
// agent's Chrome real encoding work, so a pane in a background tab, or a
// window the reader minimized, keeps its last frame dimmed and dials again
// when it comes back.
//
// Over the frame sits the agent's cursor (GhostCursor): the pixels never
// show where Chrome dispatched the last click, so the daemon sends each
// action beside the frames and the arrow glides there, rings on a press and
// captions what is typed. It hides while the human has the wheel: one hand on
// the page at a time, and the human's is the real pointer.

import { useCallback, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { deviceDisplayName } from "../DeviceBadge";
import type { SessionMachine } from "../tmuxAttach";
import { getTerminalEndpoint } from "../../lib/terminal/endpoint";
import {
  connectBrowserWatch,
  mapFromFrame,
  mapToFrame,
  watchErrorStatus,
  watchExitStatus,
  watchUnreachableStatus,
  type BrowserStreamReport,
  type WatchConnection,
  type WatchInputEvent,
  type WatchStatus,
  type WatchTabInfo,
} from "../../lib/browserWatch";
import { createGhostStore, ghostView, type GhostStore } from "../../lib/browserGhost";
import { CursorArrow } from "../presence/CursorArrow";
import { DrivingHint } from "./watchControls";
import { useDerivedSize } from "../../hooks/useDerivedSize";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export function BrowserStream({
  sessionUuid,
  tmuxSession,
  machine,
  /** False while the machine lookup is still out: dialing before it lands
   *  would broadcast discovery to every device and then tear the wrong socket
   *  back down. */
  machineSettled = true,
  paneActive,
  control,
  reloadToken,
  onState,
  onTitle,
  onUrl,
  onReleaseControl,
}: {
  sessionUuid?: string | null;
  tmuxSession?: string | null;
  machine?: SessionMachine | null;
  machineSettled?: boolean;
  /** This view's own tab is the one on screen. Combined with the document's
   *  visibility it decides whether anyone is looking at all; false drops the
   *  socket and dims the last frame. */
  paneActive: boolean;
  /** The host's drive toggle. The daemon decides whether control is on offer
   *  (`controlAvailable` in the report); this is the human's answer to it. */
  control: boolean;
  /** Bumped by the host to dial again — retry, resume, reload. */
  reloadToken: number;
  onState: (report: BrowserStreamReport) => void;
  onTitle?: (title: string | null) => void;
  onUrl?: (url: string) => void;
  /** Esc while driving. Without it, Esc goes to the page like any other key. */
  onReleaseControl?: () => void;
}) {
  const convex = useConvex();
  const [status, setStatus] = useState<WatchStatus>({ kind: "connecting" });
  const [tab, setTab] = useState<WatchTabInfo | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [controlAvailable, setControlAvailable] = useState(false);
  // The frame's own pixel size, from the daemon: the overlay scales the
  // agent's normalized points into the letterboxed content rect with it.
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [nav, setNav] = useState<{ url: string; at: number } | null>(null);
  const connRef = useRef<WatchConnection | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // One cursor memory per stream. Actions from the socket go straight in and
  // only the overlay listens, so a burst of moves never re-renders the stream.
  const ghostRef = useRef<GhostStore | null>(null);
  if (!ghostRef.current) ghostRef.current = createGhostStore();
  const ghost = ghostRef.current;

  const machineName = machine ? deviceDisplayName(machine as any) : null;
  const foreign = !!machine && !machine.is_mine;
  // Two facts, both outside React: the pane's tab is the visible one (the host
  // knows that) and this document is not behind another window's tab.
  const documentVisible = useSyncExternalStore(subscribeVisibility, readVisibility, () => false);
  const visible = paneActive && documentVisible;

  useWatchEffect(() => {
    if (!machineSettled) return;
    if (!visible) {
      // The previous run's cleanup already closed the socket; this run exists
      // only to say why the picture stopped moving.
      setStatus({ kind: "paused" });
      return;
    }
    let cancelled = false;
    setStatus({ kind: "connecting" });

    (async () => {
      if (foreign) {
        setStatus(watchUnreachableStatus({ foreign: true, machineName, hasDevice: !!machine?.device_id }));
        return;
      }
      const endpoint = await getTerminalEndpoint(convex, { deviceId: machine?.device_id });
      if (cancelled) return;
      if (!endpoint) {
        setStatus(
          watchUnreachableStatus({ foreign: false, machineName, hasDevice: !!machine?.device_id }),
        );
        return;
      }
      connRef.current = connectBrowserWatch(
        endpoint,
        { sessionUuid, tmuxSession, control: true },
        {
          onReady(t, granted) {
            if (cancelled) return;
            // A new stream starts with no cursor memory: the daemon replays
            // the tab's recent actions right after ready, so a cursor that
            // is still current comes straight back, and a stale one from a
            // tab this session left does not.
            ghost.reset();
            setTab(t);
            setControlAvailable(granted);
            setStatus({ kind: "live" });
          },
          onFrame(dataUrl, w, h) {
            if (cancelled) return;
            setFrame(dataUrl);
            if (w && h) setFrameSize((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
          },
          onTab(t) {
            if (!cancelled) setTab(t);
          },
          onAction(a) {
            if (cancelled) return;
            ghost.push(a);
            if (a.kind === "nav" && a.url) {
              // The address changes the moment the page does, not on the
              // daemon's next tab poll; the host flashes it keyed on `at`.
              const url = a.url;
              setTab((t) => (t && t.url !== url ? { ...t, url } : t));
              setNav({ url, at: a.at });
            }
          },
          onError(code, message) {
            if (!cancelled) setStatus(watchErrorStatus(code, message));
          },
          onExit(reason) {
            if (!cancelled) setStatus(watchExitStatus(reason));
          },
        },
      );
    })();

    return () => {
      cancelled = true;
      connRef.current?.close();
      connRef.current = null;
    };
  }, [
    convex,
    ghost,
    sessionUuid,
    tmuxSession,
    machineSettled,
    foreign,
    machine?.device_id,
    machineName,
    visible,
    reloadToken,
  ]);

  // The tab's own identity, for hosts that put it in their chrome.
  useWatchEffect(() => {
    onTitle?.(tab?.title?.trim() || null);
    if (tab?.url) onUrl?.(tab.url);
  }, [tab?.title, tab?.url, onTitle, onUrl]);

  // One report per real change. `hasFrame` is a boolean on purpose: frames
  // arrive three times a second and re-rendering the host at that rate to say
  // "still a picture" would be the churn this app has a rule against.
  const hasFrame = !!frame;
  useWatchEffect(() => {
    onState({ status, tab, controlAvailable, hasFrame, nav });
  }, [status, tab, controlAvailable, hasFrame, nav, onState]);

  const live = status.kind === "live";
  const driving = live && control && controlAvailable;
  const paused = status.kind === "paused";

  return (
    <div ref={boxRef} className="absolute inset-0">
      {frame && (
        <img
          ref={imgRef}
          src={frame}
          alt={tab?.title ? `Live view of ${tab.title}` : "Live view of the agent's browser tab"}
          className={`absolute inset-0 w-full h-full object-contain transition-opacity ${
            paused ? "opacity-40" : ""
          }`}
          draggable={false}
        />
      )}
      {frame && (
        <GhostCursor store={ghost} boxRef={boxRef} imgRef={imgRef} frameSize={frameSize} hidden={driving} />
      )}
      {driving && (
        <ControlSurface imgRef={imgRef} connRef={connRef} onRelease={onReleaseControl} />
      )}
      {driving && <DrivingHint />}
      {paused && frame && (
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-sol-bg/80 border border-sol-border/40 text-[10px] font-mono tracking-wider text-sol-text-dim">
          paused
        </span>
      )}
    </div>
  );
}

// ── The agent's cursor ───────────────────────────────────────────────────────
// An arrow in the agent's color (violet, the palette's default for an agent;
// the human's own control surface is cyan) that glides to each action point,
// rings on a press and captions what is typed, then fades once the agent has
// been still for a few seconds. Never takes a pointer event: it is a drawing
// over the frame, not a surface. The 160ms glide and the ring are the same
// motion as the extension's in page arrow (background.js __castPointer), so
// the cursor looks the same whether seen in the tab or in the stream.
//
// Geometry: the frame renders object-contain, so the content rect is the
// frame's aspect fit inside this box; mapFromFrame (unit-tested) is the
// inverse of the control surface's mapToFrame, so the arrow lands where a
// click sent from the same spot would.

const GHOST_TRANSITION = "transform 160ms cubic-bezier(.2,.7,.2,1), opacity 300ms ease";

function GhostCursor({
  store,
  boxRef,
  imgRef,
  frameSize,
  hidden,
}: {
  store: GhostStore;
  boxRef: React.RefObject<HTMLDivElement | null>;
  imgRef: React.RefObject<HTMLImageElement | null>;
  /** The frame's pixel size as the daemon reported it; the <img>'s natural
   *  size stands in when a polling engine sent none. */
  frameSize: { width: number; height: number } | null;
  /** The human has the wheel: the arrow hides and keeps its place, so it
   *  returns where it was when the agent is back. A stream that stopped being
   *  live is not hidden here: with no actions arriving the arrow freezes where
   *  it was and fades on the idle window, like an agent that went still. */
  hidden: boolean;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // A fade is a question of time, not of a new action: wake exactly when the
  // view says something changes, and not otherwise.
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const view = ghostView(state, Date.now());
  useWatchEffect(() => {
    if (view.nextChangeAt === null) return;
    const t = setTimeout(wake, Math.max(0, view.nextChangeAt - Date.now()) + 16);
    return () => clearTimeout(t);
  }, [view.nextChangeAt]);
  // The box only re-renders this overlay when its rounded size changes.
  const boxSig = useDerivedSize(boxRef, (w, h) => `${Math.round(w)}x${Math.round(h)}`, () => "0x0");
  const [boxW, boxH] = boxSig.split("x").map(Number);

  const natural = frameSize ?? (imgRef.current ? { width: imgRef.current.naturalWidth, height: imgRef.current.naturalHeight } : null);
  const point = state.point && natural ? mapFromFrame(state.point.x, state.point.y, { left: 0, top: 0, width: boxW, height: boxH }, natural) : null;
  if (!point) return null;
  const visible = view.visible && !hidden;
  const captionText = state.caption?.text ?? null;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div
        data-sv-ghost-cursor
        data-visible={visible ? "true" : "false"}
        className="absolute left-0 top-0 w-7 h-9 will-change-transform"
        style={{ transform: `translate(${point.x}px, ${point.y}px)`, opacity: visible ? 1 : 0, transition: GHOST_TRANSITION }}
      >
        {view.ripple !== null && (
          <span
            key={view.ripple}
            data-sv-ghost-ripple
            className="absolute -left-[14px] -top-[14px] w-9 h-9 rounded-full border-2 border-sol-violet cc-ghost-ripple"
          />
        )}
        <CursorArrow color="var(--sol-violet)" />
        {captionText !== null && (
          <span
            data-sv-ghost-caption
            className="absolute left-6 top-7 max-w-[240px] truncate px-1.5 py-0.5 rounded bg-sol-bg/90 border border-sol-violet/40 text-[10px] font-mono text-sol-text whitespace-nowrap"
            style={{ opacity: view.caption !== null ? 1 : 0, transition: "opacity 300ms ease" }}
          >
            {captionText}
          </span>
        )}
      </div>
    </div>
  );
}

function subscribeVisibility(fn: () => void): () => void {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}

function readVisibility(): boolean {
  return document.visibilityState === "visible";
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
  onRelease,
}: {
  imgRef: React.RefObject<HTMLImageElement | null>;
  connRef: React.RefObject<WatchConnection | null>;
  /** Esc hands the keyboard back instead of reaching the page. A capture
   *  surface with no way out is a trap, and Esc is the way out people try. */
  onRelease?: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const lastMoveAt = useRef(0);

  // Keys should land in the page the moment control turns on, without an
  // extra "click to focus" step the user has no way to discover.
  useMountEffect(() => {
    surfaceRef.current?.focus();
  });

  const toNorm = useCallback(
    (clientX: number, clientY: number): { nx: number; ny: number } | null => {
      const img = imgRef.current;
      if (!img) return null;
      // object-contain: the content rect is the image aspect fit inside the
      // box; the geometry lives in mapToFrame (unit-tested).
      return mapToFrame(clientX, clientY, img.getBoundingClientRect(), {
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
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
    if (e.key === "Escape" && onRelease) {
      e.preventDefault();
      onRelease();
      return;
    }
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
      aria-label="You have the wheel of the agent's browser tab: clicks and typing go to the page, Esc hands it back"
      className="absolute inset-0 cursor-crosshair outline-none ring-2 ring-inset ring-sol-cyan/60 focus:ring-sol-cyan"
      style={{ boxShadow: "inset 0 0 28px color-mix(in srgb, var(--sol-cyan) 18%, transparent)" }}
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
