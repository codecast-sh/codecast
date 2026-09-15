"use client";

// Live view of the browser tab an agent is driving, docked into the
// conversation the same way the terminal split is (ConversationTerminal.tsx).
//
// The stream itself is BrowserStream's: this file is the dock — where it sits,
// how tall it is, and the 24px bar of chrome above it. Everything about the
// connection, the frame, control mode and what each ending means lives in
// BrowserStream and lib/browserWatch, and the same pair renders the tab as a
// stage pane (backends/StreamBackend). Two places to look at an agent's
// browser, one place where each of them is explained.
//
// Open state and heights live at module level keyed by conversation, so
// switching conversations and back preserves the split — but unlike the
// terminal (whose xterm buffer is expensive to rebuild) the stream itself is
// torn down on unmount and redialed on mount: a screencast nobody is looking
// at should not keep Chrome encoding JPEGs.

import { useCallback, useState, useSyncExternalStore } from "react";
import { X, RotateCw, MousePointerClick } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useTabActive } from "../../hooks/usePagePresence";
import { deviceDisplayName } from "../DeviceBadge";
import { SplitResizeHandle } from "../SplitResizeHandle";
import type { SessionMachine } from "../tmuxAttach";
import type { BrowserStreamReport } from "../../lib/browserWatch";
import type { BrowserRowState } from "../castCommand";
import { BrowserStream } from "./BrowserStream";
import { BrowserTabActionLabel } from "./BrowserTabPill";
import { BROWSER_ROW_PILL, useBrowserTabActions } from "../../hooks/useBrowserTabActions";

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

/** What the bar says about the stream, in the two words a dock has room for. */
function statusLabel(report: BrowserStreamReport): string {
  switch (report.status.kind) {
    case "live":
      return "LIVE";
    case "connecting":
      return "CONNECTING";
    case "paused":
      return "PAUSED";
    default:
      return "OFF AIR";
  }
}

export function BrowserWatchSplit({
  convKey,
  sessionUuid,
  tmuxSession,
  lastPage,
}: {
  convKey: string;
  sessionUuid?: string | null;
  tmuxSession?: string | null;
  /** The page and tab the transcript last named, for the reopen offer and
   *  the open-tab pill before the stream has said which tab it is on. */
  lastPage?: BrowserRowState | null;
}) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const split = splits.get(convKey);
  if (!split) return null;
  return <SplitBody convKey={convKey} split={split} sessionUuid={sessionUuid ?? null} tmuxSession={tmuxSession ?? null} lastPage={lastPage ?? null} />;
}

function SplitBody({
  convKey,
  split,
  sessionUuid,
  tmuxSession,
  lastPage,
}: {
  convKey: string;
  split: SplitState;
  sessionUuid: string | null;
  tmuxSession: string | null;
  lastPage: BrowserRowState | null;
}) {
  const [report, setReport] = useState<BrowserStreamReport>({
    status: { kind: "connecting" },
    tab: null,
    controlAvailable: false,
    hasFrame: false,
    nav: null,
  });
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  // The wheel: the daemon offers it on ready; taking it is the human's choice,
  // and the button reads as a handoff, not a setting.
  const [controlOn, setControlOn] = useState(false);
  // Bumped to force a reconnect; BrowserStream redials on every change.
  const [attempt, setAttempt] = useState(0);

  // Which machine the agent (and so its browser) lives on. Enrichment only —
  // useQueryNoThrow per the header-outage rule; without an answer the stream
  // still tries local discovery, which is correct on a one-machine setup.
  const machineQuery = useQueryNoThrow(
    api.devices.getConversationMachine,
    convKey ? ({ conversation_id: convKey as any } as any) : "skip",
  );
  const machine = machineQuery.data as SessionMachine | null | undefined;
  const machineSettled = machine !== undefined || !!machineQuery.error;
  const machineName = machine ? deviceDisplayName(machine as any) : null;
  // The conversation is on screen when its tab is; a background tab keeps the
  // split mounted, and a stream nobody can see is Chrome encoding for nobody.
  const tabActive = useTabActive();

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const close = () => toggleBrowserWatch(convKey);
  const status = report.status;
  const tab = report.tab;
  const failed = status.kind === "failed" ? status : null;
  // The same focus/reopen the row pill has: raise the streamed tab in Chrome,
  // and when the stream failed for want of a tab, bring the last page back —
  // the stream then redials onto the reopened tab.
  const tabActions = useBrowserTabActions(
    { tabId: tab?.id || lastPage?.tabId || null, url: tab?.url || lastPage?.url || null },
    { sessionUuid, tmuxSession },
    reconnect,
  );
  const reopenOffered = !!failed?.tabGone && !!(tab?.url || lastPage?.url) && !!(sessionUuid || tmuxSession);

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
          {statusLabel(report)}
        </span>
        {tab && (
          <>
            <span className="text-[10px] font-mono text-sol-text-muted truncate">{tab.title || "untitled"}</span>
            {tab.url && (
              // Keyed on the navigation time so the flash restarts per
              // navigation and never on an unrelated re-render.
              <span
                key={report.nav?.at ?? 0}
                className={`text-[10px] font-mono text-sol-text-dim/70 truncate rounded px-0.5 -mx-0.5 ${report.nav ? "cc-nav-flash" : ""}`}
                title={tab.url}
              >
                {tab.url}
              </span>
            )}
          </>
        )}
        {tabActions.tabId && (
          <button
            type="button"
            onClick={tabActions.state.kind === "offer" ? tabActions.reopen : tabActions.focus}
            title={`Focus tab ${tabActions.tabId.slice(0, 8)} in the agent's browser${machineName ? ` on ${machineName}` : ""}`}
            className={`${BROWSER_ROW_PILL} ${
              tabActions.state.kind === "busy" ? "text-sol-cyan border-sol-cyan/40" : tabActions.state.kind === "note" ? "text-sol-red/80 border-sol-red/30" : ""
            }`}
            aria-busy={tabActions.state.kind === "busy"}
          >
            <BrowserTabActionLabel state={tabActions.state} idle={<span>open tab</span>} />
          </button>
        )}
        <span className="flex-1" />
        {live && report.controlAvailable && (
          <button
            data-sv-wheel
            aria-pressed={controlOn}
            onClick={() => setControlOn((v) => !v)}
            title={
              controlOn
                ? "Hand the page back to the agent (Esc)"
                : "Take the wheel: your clicks and typing go to this page, for a sign-in the agent cannot do"
            }
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono tracking-wider transition-colors ${
              controlOn
                ? "bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/40"
                : "text-sol-text-dim/60 hover:text-sol-cyan border border-transparent"
            }`}
          >
            <MousePointerClick className="w-3 h-3" />
            {controlOn ? "HAND BACK" : "TAKE THE WHEEL"}
          </button>
        )}
        {failed?.canRetry && (
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
        <BrowserStream
          sessionUuid={sessionUuid}
          tmuxSession={tmuxSession}
          machine={machine ?? null}
          machineSettled={machineSettled}
          paneActive={tabActive}
          control={controlOn}
          reloadToken={attempt}
          onState={setReport}
          onReleaseControl={() => setControlOn(false)}
        />
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[11px] font-mono text-center px-6 bg-sol-bg/80">
            <span className="text-sol-text-dim">{failed.message}</span>
            <div className="flex items-center gap-2">
              {reopenOffered && (
                <button
                  onClick={tabActions.reopen}
                  disabled={tabActions.state.kind === "busy"}
                  title={`Reopen ${tab?.url || lastPage?.url} in the cast browser, as this session, then stream it here`}
                  className="px-2 py-0.5 rounded border border-sol-yellow/50 text-sol-yellow hover:border-sol-yellow transition-colors disabled:opacity-60"
                >
                  {tabActions.state.kind === "busy" ? "Reopening…" : "Reopen in cast browser"}
                </button>
              )}
              {failed.canRetry && (
                <button
                  onClick={reconnect}
                  className="px-2 py-0.5 rounded border border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors"
                >
                  {failed.capped ? "Resume" : "Reconnect"}
                </button>
              )}
            </div>
            {tabActions.state.kind === "note" && <span className="text-sol-red/80">{tabActions.state.text}</span>}
          </div>
        ) : status.kind === "connecting" && !report.hasFrame ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-sol-text-dim">
            Opening a live view of the agent's browser…
          </div>
        ) : null}
      </div>

      <SplitResizeHandle onPointerDown={onHandlePointerDown} title="Drag to resize" />
    </div>
  );
}
