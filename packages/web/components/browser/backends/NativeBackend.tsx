"use client";
// The desktop's native view: a real Chromium view the shell places over this
// pane's rect, so any site loads — including the many that refuse to be framed.
//
// The view is NOT in the DOM. That is the whole trick and the whole cost. The
// trick: nothing is being embedded, so X-Frame-Options has no say, the page
// gets a normal origin, and it can have its own devtools. The cost: the view
// paints above every pixel the app draws, and it knows nothing about layout —
// so this component is, in effect, the view's layout engine. It measures the
// rect a pane occupies and tells the shell; it hides the view the moment the
// app draws anything over that rect (lib/nativeOverlayGuard.ts), the tab goes
// away, or the document is hidden; and it takes the view down on unmount.
//
// Everything else is a translation: the shell's pane events become the same
// onTitle/onUrl/onState the frame backend reports, so BrowserPane cannot tell
// which backend is under it.

import { ChevronLeft, ChevronRight, Code2, MonitorOff } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { browserPaneBridge, type BrowserPaneEvent } from "../../../lib/desktop";
import { useNativeBrowserPane } from "../../../hooks/useNativeBrowserPane";
import { displayHost, isLoopbackUrl } from "../../../lib/browserPane";
import { paneIsCovered, watchOverlays } from "../../../lib/nativeOverlayGuard";
import { stageFocus } from "../../../lib/stage";
import { useTabContext } from "../../../lib/tabParams";
import type { BackendProps, PaneStripAction } from "./types";
import { PaneCard } from "./PaneCard";

/** How long to keep re-measuring after something moved the pane. A split
 *  animates, a sidebar collapses over 200ms, a drag settles — the view has to
 *  follow the pane through the motion, not jump to where it ended up. */
const CHASE_MS = 600;

/** Chromium's verdicts that mean "nothing answered", as opposed to a page that
 *  loaded badly. Everything else is shown with its own description. */
const UNREACHABLE_CODES = new Set([
  -105, // NAME_NOT_RESOLVED
  -106, // INTERNET_DISCONNECTED
  -102, // CONNECTION_REFUSED
  -104, // CONNECTION_FAILED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
  -7, //   TIMED_OUT
]);

export function NativeBackend({
  source,
  focused,
  reloadToken,
  onTitle,
  onUrl,
  onState,
  onActions,
}: BackendProps) {
  const url = source.kind === "url" ? source.url : "";
  const paneId = useId();
  const ctx = useTabContext();
  const leafId = ctx?.leafId;
  const host = useRef<HTMLDivElement>(null);
  const available = useNativeBrowserPane();
  const pane = useMemo(() => browserPaneBridge(), []);
  // The bridge, but only once the shell has ANSWERED that it has the view.
  // The route can force this backend onto a build without one (`&native=1` on
  // an older desktop), and the capability probe resolves a tick after boot, so
  // the bridge existing proves nothing. Every effect below gates on this
  // rather than on the bridge: ungated, a pane would ask a shell that cannot
  // answer, and would still put back, forward and devtools in the strip over
  // a card saying the view is unavailable.
  const live = available ? pane : null;
  const [failed, setFailed] = useState<string | null>(null);

  // Focus is NOT a reason to hide. In a split, the pane beside the one being
  // typed into is still on screen, and reading a page while writing next to
  // it is the point of putting it there. Visibility is only "does the pane
  // have area": a tab that is not the visible one is display:none, so its rect
  // is empty and the check below hides the view without being told.
  const lastSent = useRef<string>("");

  const measure = useCallback(() => {
    const el = host.current;
    if (!el || !live) return;
    const r = el.getBoundingClientRect();
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    const show =
      r.width > 0 &&
      r.height > 0 &&
      (typeof document === "undefined" || !document.hidden) &&
      !paneIsCovered({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    // The shell is another process: an unchanged rect sent 60 times a second
    // is 60 IPC round trips for nothing.
    const signature = `${show}:${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (signature === lastSent.current) return;
    lastSent.current = signature;
    void live.send("bounds", { paneId, rect, visible: show });
  }, [live, paneId]);

  // One rAF chain, started by anything that can move the pane and running just
  // long enough to follow an animation to its end.
  const chasing = useRef(0);
  const until = useRef(0);
  const chase = useCallback(() => {
    if (typeof window === "undefined") return;
    until.current = Date.now() + CHASE_MS;
    if (chasing.current) return;
    const step = () => {
      measure();
      if (Date.now() < until.current) chasing.current = requestAnimationFrame(step);
      else chasing.current = 0;
    };
    chasing.current = requestAnimationFrame(step);
  }, [measure]);

  // Create the view, and take it down again when the pane goes. A pane that
  // unmounted with its view still up would leave a page floating over the
  // stage, owned by nothing.
  useWatchEffect(() => {
    if (!live || !url) return;
    let mounted = true;
    setFailed(null);
    onTitle(null);
    onState({ kind: "loading" });
    const el = host.current;
    const r = el?.getBoundingClientRect();
    void live
      .send("create", {
        paneId,
        url,
        rect: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : undefined,
        visible: false,
        // The offering session, so the shell's pane registry names who may
        // drive this view from `cast browser` (lib/browserPane.ts).
        session: source.kind === "url" ? source.session : undefined,
      })
      .then((answer) => {
        if (!mounted) return;
        const ok = (answer as { ok?: boolean })?.ok !== false;
        if (!ok) {
          const reason = (answer as { reason?: string })?.reason ?? "unknown";
          setFailed(reason);
          onState({ kind: "error", message: "The desktop shell refused to open this view" });
          return;
        }
        lastSent.current = "";
        chase();
      })
      .catch(() => {
        if (!mounted) return;
        setFailed("bridge");
        onState({ kind: "error", message: "The desktop shell did not answer" });
      });
    return () => {
      mounted = false;
      void live.send("destroy", { paneId });
      lastSent.current = "";
    };
    // onTitle/onState are stable callbacks from the pane; the view is created
    // per address, and a new address is a new page. The session rides the
    // same route as the address, so it changes only when the address does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, paneId, url]);

  // Everything that can move, cover or reveal the pane.
  useWatchEffect(() => {
    if (!live || !url || typeof window === "undefined") return;
    const el = host.current;
    const ro = new ResizeObserver(chase);
    if (el) ro.observe(el);
    const stopOverlays = watchOverlays(chase);
    window.addEventListener("resize", chase);
    window.addEventListener("scroll", chase, true);
    document.addEventListener("visibilitychange", chase);
    chase();
    return () => {
      ro.disconnect();
      stopOverlays();
      window.removeEventListener("resize", chase);
      window.removeEventListener("scroll", chase, true);
      document.removeEventListener("visibilitychange", chase);
      if (chasing.current) cancelAnimationFrame(chasing.current);
      chasing.current = 0;
    };
  }, [live, url, chase]);

  // The tab this pane lives in became the visible one, or stopped being it.
  // Not a rect change, so nothing else would notice.
  useWatchEffect(() => {
    chase();
  }, [focused, chase]);

  // The strip's reload button and Cmd+R both land here.
  const firstReload = useRef(reloadToken);
  useWatchEffect(() => {
    if (!live || reloadToken === firstReload.current) return;
    void live.send("reload", { paneId });
  }, [live, paneId, reloadToken]);

  // What the shell sees about the page, translated into what the pane shows.
  useWatchEffect(() => {
    if (!live) return;
    return live.on((e: BrowserPaneEvent) => {
      if (e.paneId !== paneId) return;
      switch (e.event) {
        case "title":
          onTitle(e.title ?? null);
          break;
        case "url":
          if (e.url) onUrl(e.url);
          break;
        case "loading":
          // A native view reads its own page, so it is never opaque: the strip
          // can stop offering "did this even load?" — it knows.
          onState(e.loading ? { kind: "loading" } : { kind: "ready", opaque: false });
          break;
        case "fail":
          onState(
            UNREACHABLE_CODES.has(e.errorCode ?? 0)
              ? { kind: "unreachable", loopback: isLoopbackUrl(e.url ?? url) }
              : { kind: "error", message: e.errorDescription ?? "The page did not load" },
          );
          break;
        case "focus":
          // A click inside the page is how a person moves between panes, and
          // the stage's focus ring has to follow it.
          if (leafId) stageFocus(leafId);
          break;
        case "chord":
          // The page had keyboard focus, so the app never saw these. Reload is
          // this pane's own; the others are re-raised as the keystroke they
          // were, and the app's own handlers take them from there.
          if (e.key === "r") void live.send("reload", { paneId });
          else raiseChord(e.key ?? "");
          break;
      }
    });
  }, [live, paneId, leafId, url, onTitle, onUrl, onState]);

  // Back, forward and this pane's own devtools, in the pane's strip.
  useWatchEffect(() => {
    if (!onActions) return;
    if (!live || !url) {
      onActions([]);
      return;
    }
    const actions: PaneStripAction[] = [
      {
        icon: <ChevronLeft className="w-3.5 h-3.5" />,
        label: "Back to the previous page",
        onClick: () => void live.send("back", { paneId }),
      },
      {
        icon: <ChevronRight className="w-3.5 h-3.5" />,
        label: "Forward to the next page",
        onClick: () => void live.send("forward", { paneId }),
      },
      {
        icon: <Code2 className="w-3.5 h-3.5" />,
        label: "Open developer tools for this pane",
        onClick: () => void live.send("devtools", { paneId }),
      },
    ];
    onActions(actions);
    return () => onActions([]);
  }, [onActions, live, paneId, url]);

  if (!live || failed) {
    return (
      <PaneCard
        icon={<MonitorOff className="w-5 h-5" />}
        host={url ? displayHost(url) : undefined}
        headline={
          live
            ? "The native view could not be opened here"
            : "The native view needs the desktop app"
        }
        detail={
          live
            ? "The shell refused this window a view. Open the page in your browser from the strip above."
            : "It draws the page outside the app, so sites that refuse to be embedded still open. In a browser tab, use the frame or open the page in a window of its own."
        }
      />
    );
  }

  // Nothing but a hole the right shape: the page itself is painted by the
  // shell, over exactly this rect.
  return <div ref={host} className="w-full h-full bg-sol-bg" data-native-pane={paneId} />;
}

/** Re-raise a key the page swallowed, as the app's own keystroke. */
function raiseChord(key: string) {
  if (!key || typeof window === "undefined") return;
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export default NativeBackend;
