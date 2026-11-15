import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useEventListener } from "./useEventListener";
import { useNarrowStage } from "./useNarrowStage";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import { usePageEmbedFeed, type PageInfo } from "./usePageInfo";
import { useTabContext } from "../lib/tabParams";
import { stageHasRoom } from "../lib/stage";
import {
  applyCanvasStep,
  canvasEntryOn,
  canvasHasFocus,
  canvasKeptHere,
  canvasLeafPath,
  canvasOwner,
  canvasPanePath,
  canvasPathSession,
  canvasPageUrl,
  canvasTarget,
  claimCanvas,
  dropCanvasKeep,
  keepCanvasHere,
  planCanvas,
  setSessionCanvas,
  subscribeCanvasOwner,
  type CanvasPage,
} from "../lib/sessionCanvas";

const NO_PAGES: CanvasPage[] = [];
export const CANVAS_NO_ROOM = "No room beside this conversation: close a pane first";

/** The canvas for one conversation: whether it is on, which page it shows,
 *  and the effect that keeps its tab's canvas pane in step. Only the tab's
 *  canvas owner drives the pane, and only while that tab is on screen. */
export function useSessionCanvas(conversationId: string | null) {
  const pane = useTabContext();
  const activeTabId = useInboxStore((st) => st.activeTabId);
  const tabId = pane?.tabId ?? activeTabId ?? null;
  const visible = pane ? (pane.isVisible ?? pane.isActive) : true;
  const focused = pane ? pane.isActive : true;
  const narrow = useNarrowStage();

  const s = useTrackedStore([
    (st) => st.clientStateInitialized,
    (st) => (conversationId ? st.clientState.ui?.session_canvas?.[conversationId] : undefined),
    (st) => (conversationId ? (st as any).conversationPages?.[conversationId]?.pages : undefined),
    (st) => {
      const rows = conversationId ? (st as any).conversationPages?.[conversationId]?.pages : undefined;
      return (rows ?? []).map((p: CanvasPage) => {
        const info: PageInfo | undefined = (st as any).pageEmbeds?.[p.slug];
        return `${p.slug}:${info ? (info.missing ? "x" : info.version ?? "") : "?"}:${info?.title ?? ""}`;
      }).join(",");
    },
    (st) => canvasLeafPath(st.tabs.find((t) => t.id === tabId) ?? null),
  ]);
  const entry = conversationId ? s.clientState.ui?.session_canvas?.[conversationId] : undefined;
  // Another window's pane closing leaves this window's docked pane where it is
  // (keptHere); the header control's off reaches every window.
  const [keptTick, setKeptTick] = useState(0);
  const on = canvasEntryOn(entry) || (!!entry?.closed && !!conversationId && canvasKeptHere(conversationId));
  const pages: CanvasPage[] = (conversationId ? (s as any).conversationPages?.[conversationId]?.pages : undefined) ?? NO_PAGES;
  const infoOf = (slug: string): PageInfo | undefined => (s as any).pageEmbeds?.[slug];
  const target = canvasTarget(pages, entry?.pin ?? null, infoOf);
  const info = target ? infoOf(target) : undefined;
  // A pin whose page is gone no longer holds anything: the canvas shows the latest.
  const pin = entry?.pin && entry.pin === target ? entry.pin : null;
  const leafPath = canvasLeafPath(s.tabs.find((t) => t.id === tabId) ?? null);

  // The session list feeds every page's info, but caps how many; the page on
  // the canvas is fed on its own so it always arrives.
  usePageEmbedFeed(useMemo(() => (on && target ? [{ slug: target }] : []), [on, target]));

  // Ownership: the conversation whose pane was focused last, or whose visible
  // pane just switched to it, drives the tab's canvas.
  const owner = useSyncExternalStore(subscribeCanvasOwner, () => (tabId ? canvasOwner(tabId) : null), () => null);
  const shown = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!conversationId || !tabId || !visible) return;
    const switched = shown.current !== null && shown.current !== conversationId;
    shown.current = conversationId;
    if (focused || switched || !canvasOwner(tabId)) claimCanvas(tabId, conversationId);
  }, [conversationId, tabId, visible, focused]);
  const drives = !!conversationId && !!tabId && visible && owner === conversationId;

  // The pane waits for the page's version, so it loads once rather than
  // twice when the version arrives.
  const pending = !!target && !info;
  const wantPath = on && target && info && !info.missing
    ? canvasPanePath(canvasPageUrl(target, info.version), conversationId!)
    : null;

  // A re-point held while the page had focus runs when focus comes back to
  // the app (the window's own focus event fires as the frame lets go).
  const [held, setHeld] = useState(false);
  const [retry, setRetry] = useState(0);
  useEventListener("focus", () => { if (held) setRetry((n) => n + 1); });

  // Closing the pane from its own controls, or pointing it somewhere else,
  // turns the canvas off; a pane this hook took away does not.
  const seen = useRef<{ id: string | null; docked: boolean }>({ id: null, docked: false });
  useWatchEffect(() => {
    if (!drives || !s.clientStateInitialized) return;
    const id = conversationId!;
    if (seen.current.id !== id) {
      // A keep holds only the pane it kept: once this pane moves to another
      // session, coming back starts from the stored preference.
      if (seen.current.id) dropCanvasKeep(seen.current.id);
      seen.current = { id, docked: false };
    }
    // A keep this pane never docked (a remount, a reload) holds nothing.
    if (canvasKeptHere(id) && !seen.current.docked) {
      dropCanvasKeep(id);
      setKeptTick((n) => n + 1);
      return;
    }
    // Another window closed its pane while this one has it docked: keep it.
    if (!on && entry?.closed && seen.current.docked && leafPath && canvasPathSession(leafPath) === id) {
      keepCanvasHere(id);
      setKeptTick((n) => n + 1);
      return;
    }
    if (on && seen.current.docked && !leafPath) {
      seen.current.docked = false;
      setSessionCanvas(id, false, null, { pane: true });
      return;
    }
    const step = planCanvas({ on, conversationId: id, leafPath, wantPath, pending, docked: seen.current.docked });
    if (step === "release") {
      seen.current.docked = false;
      setSessionCanvas(id, false, null, { pane: true });
      return;
    }
    if (step === "set" && canvasHasFocus(tabId!)) return setHeld(true);
    setHeld(false);
    if (!applyCanvasStep(step, wantPath, { tabId: tabId!, conversationId: id, ownerLeafId: pane?.leafId })) {
      // A narrow window keeps the canvas on for when it widens; a full stage
      // says so and turns it off rather than show "on" with nothing docked.
      if (!narrow) {
        toast.error(CANVAS_NO_ROOM);
        setSessionCanvas(id, false, null, { pane: true });
      }
      return;
    }
    seen.current.docked = on && (step === "insert" || step === "set" || (step === "none" && !!leafPath && !!canvasPathSession(leafPath)));
  }, [drives, s.clientStateInitialized, on, !!entry?.closed, keptTick, leafPath, wantPath, pending, retry, narrow]);

  const claim = () => { if (tabId && conversationId) claimCanvas(tabId, conversationId); };
  return { on, pin, target, title: info?.title, pages, drives, claim };
}

/** Dock one page and hold it there until the person picks another or closes
 *  the canvas: the gallery's "keep beside". */
export function dockSessionPage(conversationId: string, slug: string): boolean {
  if (!canvasLeafPath() && !stageHasRoom()) {
    toast.error(CANVAS_NO_ROOM);
    return false;
  }
  setSessionCanvas(conversationId, true, slug);
  return true;
}
