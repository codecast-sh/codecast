"use client";

// Focus / reopen for one `cast browser` tab, shared by the row pill and the
// live watch pane (components/browser). The pill talks to the daemon on this
// machine (lib/browserFocus.ts) and reports what it heard as a state.

import { createContext, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { focusBrowserTab, reopenBrowserTab, type BrowserSessionRef, type BrowserTabFailure } from "../lib/browserFocus";
import { useWatchEffect } from "./useWatchEffect";
import { useMountEffect } from "./useMountEffect";

/** The session whose browser the rows belong to, for the reopen. Provided by
 *  the conversation view; the pill can raise without it but not reopen. */
export const BrowserSessionContext = createContext<BrowserSessionRef>({});

export const BROWSER_ROW_PILL =
  "flex-shrink-0 inline-flex items-center gap-1 rounded-full border border-sol-border/60 bg-sol-bg-highlight/40 " +
  "px-1.5 py-px text-[10px] leading-4 font-mono text-sol-text-muted hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors";


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
