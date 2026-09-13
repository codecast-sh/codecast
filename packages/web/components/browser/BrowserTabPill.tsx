"use client";

// The "open tab" affordance on a `cast browser` row, and the same actions
// for the live watch pane: raise the driven tab in the human's Chrome, and
// when it is gone, offer to bring the page back.
//
// The pill talks to the daemon on this machine (lib/browserFocus.ts) and
// reports what it heard — a click that does nothing is the failure mode
// this exists to end. Everything that used to be a silent no-op is now a
// state on the pill: focusing, a reopen offer for a closed tab, a note for
// a daemon that is not here or not answering. A `cast browser` tab is only
// ever RAISED, never copied: the pill does not open the URL in the viewer's
// own browser (modified clicks keep their native open-the-URL behaviour).

import { createContext, useContext, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { focusBrowserTab, prefetchBrowserFocusEndpoint, reopenBrowserTab, type BrowserSessionRef, type BrowserTabFailure } from "../../lib/browserFocus";
import type { BrowserTabRef } from "../castCommand";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";

/** The session whose browser the rows belong to, for the reopen. Provided by
 *  the conversation view; the pill can raise without it but not reopen. */
export const BrowserSessionContext = createContext<BrowserSessionRef>({});

export const BROWSER_ROW_PILL =
  "flex-shrink-0 inline-flex items-center gap-1 rounded-full border border-sol-border/60 bg-sol-bg-highlight/40 " +
  "px-1.5 py-px text-[10px] leading-4 font-mono text-sol-text-muted hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors";

const OPEN_TAB_ICON = (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

export type BrowserTabActionState =
  | { kind: "idle" }
  | { kind: "busy"; verb: "focusing" | "reopening" }
  /** The tab is gone (or the browser is stopped); a reopen is on offer. */
  | { kind: "offer"; reason: "tab-gone" | "browser-stopped" }
  /** A transient explanation; clears itself, or on the next click. */
  | { kind: "note"; text: string };

const NOTE_MS = 6_000;

function noteFor(reason: BrowserTabFailure, detail?: string): string {
  switch (reason) {
    case "no-daemon":
      return "no cast daemon on this machine";
    case "unreachable":
      return "browser not answering — click to retry";
    case "open-failed":
      return detail ? `reopen failed: ${detail}` : "reopen failed";
    default:
      return "could not reach the tab";
  }
}

/**
 * Focus / reopen for one driven tab. `tabId` is the tab the row named; after
 * a reopen the hook follows the new tab, so the next click raises that one.
 * `url` is what a reopen brings back; without it the offer is not made.
 */
export function useBrowserTabActions(
  tab: { tabId: string | null; url: string | null },
  session: BrowserSessionRef,
  onReopened?: (tabId: string) => void,
): { state: BrowserTabActionState; tabId: string | null; focus: () => void; reopen: () => void; dismiss: () => void } {
  const convex = useConvex();
  const [state, setState] = useState<BrowserTabActionState>({ kind: "idle" });
  const [tabId, setTabId] = useState(tab.tabId);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row's tab wins whenever it changes (a later row named another tab).
  useWatchEffect(() => setTabId(tab.tabId), [tab.tabId]);
  useMountEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
  });

  const note = (text: string) => {
    setState({ kind: "note", text });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setState((s) => (s.kind === "note" ? { kind: "idle" } : s)), NOTE_MS);
  };
  const canReopen = !!tab.url && !!(session.sessionUuid || session.tmuxSession);

  const focus = () => {
    if (!tabId || state.kind === "busy") return;
    setState({ kind: "busy", verb: "focusing" });
    void focusBrowserTab(convex, tabId).then((out) => {
      if (out.ok) return setState({ kind: "idle" });
      if ((out.reason === "tab-gone" || out.reason === "browser-stopped") && canReopen) return setState({ kind: "offer", reason: out.reason });
      note(out.reason === "tab-gone" ? "tab is gone" : out.reason === "browser-stopped" ? "browser is not running" : noteFor(out.reason, out.detail));
    });
  };

  const reopen = () => {
    if (!tab.url || state.kind === "busy") return;
    setState({ kind: "busy", verb: "reopening" });
    void reopenBrowserTab(convex, { url: tab.url, ...session }).then((out) => {
      if (!out.ok) return note(noteFor(out.reason, out.detail));
      setTabId(out.tabId);
      setState({ kind: "idle" });
      onReopened?.(out.tabId);
    });
  };

  const dismiss = () => setState({ kind: "idle" });
  return { state, tabId, focus, reopen, dismiss };
}

/** The offer / busy / note rendering shared by the row pill and the watch pane. */
export function BrowserTabActionLabel({ state, idle }: { state: BrowserTabActionState; idle: React.ReactNode }) {
  switch (state.kind) {
    case "busy":
      return <span className="animate-pulse motion-reduce:animate-none">{state.verb}…</span>;
    case "offer":
      return <span>{state.reason === "tab-gone" ? "tab gone · reopen?" : "browser stopped · reopen?"}</span>;
    case "note":
      return <span>{state.text}</span>;
    default:
      return <>{idle}</>;
  }
}

function toneClass(state: BrowserTabActionState): string {
  switch (state.kind) {
    case "offer":
      return "text-sol-yellow border-sol-yellow/50 hover:text-sol-yellow hover:border-sol-yellow";
    case "note":
      return "text-sol-red/80 border-sol-red/30 hover:text-sol-red";
    case "busy":
      return "text-sol-cyan border-sol-cyan/40";
    default:
      return "";
  }
}

/**
 * "open tab" for the driven browser tab behind a tool call (browserTabOf). A
 * Claude-in-Chrome tab opens through its clau.de link. A `cast browser` tab
 * is raised in the driven Chrome; when the daemon reports it gone, the pill
 * becomes the reopen offer, and a small × declines it. Discovery of the
 * daemon's loopback endpoint starts as soon as the pill renders, so by the
 * time the human clicks the endpoint is cached.
 */
export function BrowserTabPill({ tab }: { tab: BrowserTabRef }) {
  const convex = useConvex();
  const session = useContext(BrowserSessionContext);
  const castTab = tab.kind === "cast" ? tab : null;
  const isCast = !!castTab;
  const actions = useBrowserTabActions({ tabId: castTab?.tabId ?? null, url: castTab?.url ?? null }, session);
  useWatchEffect(() => {
    if (isCast) prefetchBrowserFocusEndpoint(convex);
  }, [isCast, convex]);

  if (tab.kind === "extension") {
    return (
      <a
        href={`https://clau.de/chrome/tab/${tab.tabId}`}
        target="_blank"
        rel="noopener noreferrer"
        className={BROWSER_ROW_PILL}
        onClick={(e) => e.stopPropagation()}
        title={`View tab ${tab.tabId}`}
      >
        {OPEN_TAB_ICON}
        <span>open tab</span>
      </a>
    );
  }

  const { state } = actions;
  const title =
    state.kind === "offer"
      ? `The agent's tab is gone. Reopen ${tab.url} in the cast browser, as this session, and raise it.`
      : state.kind === "note"
        ? state.text
        : `focus tab ${actions.tabId ?? tab.tabId} in the agent's browser${tab.url ? `\n${tab.url}` : ""}`;
  return (
    <span className="inline-flex items-center gap-0.5 flex-shrink-0">
      <a
        href={tab.url ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className={`${BROWSER_ROW_PILL} ${toneClass(state)}`}
        onMouseEnter={() => prefetchBrowserFocusEndpoint(convex)}
        onClick={(e) => {
          e.stopPropagation();
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          if (state.kind === "offer") actions.reopen();
          else actions.focus();
        }}
        title={title}
        aria-busy={state.kind === "busy"}
      >
        {state.kind === "idle" && OPEN_TAB_ICON}
        <BrowserTabActionLabel state={state} idle={<span>open tab</span>} />
      </a>
      {state.kind === "offer" && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            actions.dismiss();
          }}
          className="text-[10px] leading-4 px-1 rounded-full text-sol-text-dim hover:text-sol-text-muted"
          title="Leave it closed"
          aria-label="Do not reopen"
        >
          ×
        </button>
      )}
    </span>
  );
}
