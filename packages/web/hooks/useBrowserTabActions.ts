"use client";

// Focus / reopen for one `cast browser` tab, shared by the row pill and the
// live watch pane (components/browser). The pill talks to the daemon on this
// machine (lib/browserFocus.ts) and reports what it heard as a state.

import { createContext, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { focusBrowserTab, probeBrowserTab, reopenBrowserTab, type BrowserSessionRef, type BrowserTabFailure } from "../lib/browserFocus";
import { useWatchEffect } from "./useWatchEffect";
import { useMountEffect } from "./useMountEffect";
import { bridge } from "../lib/desktop";

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
// A hover probe lists every browser's tabs; once per pill per window is plenty.
const PROBE_EVERY_MS = 5_000;

/** The daemon raised the browser too, but macOS 14+ honors that only when no
 *  other app is active. In the desktop app, which is active because the human
 *  just clicked in it, the shell repeats the raise; in a browser the page's
 *  own browser is already in front. */
function raiseInShell(pid: number | undefined): void {
  if (pid) void bridge("raiseApp")?.(pid);
}

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
 * Focus / reopen for one driven tab. `tabId` is the tab the row named (null
 * when its output named none: focus then asks for the session's tab); after
 * a reopen the hook follows the new tab, so the next click raises that one.
 * `url` is what a reopen brings back; without it the offer is not made.
 * `gone` says the transcript already knows the tab was closed (a later
 * `cast browser stop`), so the offer stands before anyone clicks.
 */
export function useBrowserTabActions(
  tab: { tabId: string | null; url: string | null; gone?: boolean },
  session: BrowserSessionRef,
  onReopened?: (tabId: string) => void,
): { state: BrowserTabActionState; tabId: string | null; focus: () => void; reopen: () => void; dismiss: () => void; check: () => void } {
  const convex = useConvex();
  const canReopen = !!tab.url && !!(session.sessionUuid || session.tmuxSession);
  const goneOffer: BrowserTabActionState | null = tab.gone && canReopen ? { kind: "offer", reason: "tab-gone" } : null;
  const [state, setState] = useState<BrowserTabActionState>(goneOffer ?? { kind: "idle" });
  const [tabId, setTabId] = useState(tab.tabId);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probedAt = useRef(0);
  // The row's tab wins whenever it changes (a later row named another tab).
  useWatchEffect(() => setTabId(tab.tabId), [tab.tabId]);
  // A stop landing later in the transcript turns an idle pill into the offer.
  useWatchEffect(() => {
    if (goneOffer) setState((s) => (s.kind === "idle" ? goneOffer : s));
  }, [!!goneOffer]);
  useMountEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
  });

  const note = (text: string) => {
    setState({ kind: "note", text });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setState((s) => (s.kind === "note" ? { kind: "idle" } : s)), NOTE_MS);
  };

  const bySession = !!(session.sessionUuid || session.tmuxSession);
  const focus = () => {
    if ((!tabId && !bySession) || state.kind === "busy") return;
    setState({ kind: "busy", verb: "focusing" });
    void focusBrowserTab(convex, { tabId, ...session }).then((out) => {
      if (out.ok) {
        raiseInShell(out.pid);
        return setState({ kind: "idle" });
      }
      if ((out.reason === "tab-gone" || out.reason === "browser-stopped") && canReopen) return setState({ kind: "offer", reason: out.reason });
      note(out.reason === "tab-gone" ? "tab is gone" : out.reason === "browser-stopped" ? "browser is not running" : noteFor(out.reason, out.detail));
    });
  };

  // The transcript learns a tab is gone only when the agent's stop syncs back,
  // seconds or more after the tab closed. Asking the daemon on hover turns
  // the pill into the reopen offer before the click instead of after it, and
  // takes the offer back when the session still drives a tab (the daemon
  // answers for the session's current tab when the row's is gone).
  const check = () => {
    if (!canReopen || (state.kind !== "idle" && state.kind !== "offer") || (!tabId && !bySession)) return;
    const now = Date.now();
    if (now - probedAt.current < PROBE_EVERY_MS) return;
    probedAt.current = now;
    void probeBrowserTab(convex, { tabId, ...session }).then((out) => {
      if (out.ok) return setState((s) => (s.kind === "offer" ? { kind: "idle" } : s));
      if (out.reason !== "tab-gone" && out.reason !== "browser-stopped") return;
      const reason = out.reason;
      setState((s) => (s.kind === "idle" ? { kind: "offer", reason } : s));
    });
  };

  const reopen = () => {
    if (!tab.url || state.kind === "busy") return;
    setState({ kind: "busy", verb: "reopening" });
    void reopenBrowserTab(convex, { url: tab.url, ...session }).then((out) => {
      if (!out.ok) return note(noteFor(out.reason, out.detail));
      raiseInShell(out.pid);
      setTabId(out.tabId);
      setState({ kind: "idle" });
      onReopened?.(out.tabId);
    });
  };

  // Declining the offer also stops the hover probe from making it again.
  const dismiss = () => {
    probedAt.current = Infinity;
    setState({ kind: "idle" });
  };
  return { state, tabId, focus, reopen, dismiss, check };
}
