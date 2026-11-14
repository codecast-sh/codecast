import { useRef } from "react";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import { pageGateKeys, type PageInfo } from "./usePageInfo";
import {
  applyCanvasStep,
  canvasLeafPath,
  canvasPanePath,
  canvasPageUrl,
  canvasTarget,
  planCanvas,
  setSessionCanvas,
  type CanvasPage,
} from "../lib/sessionCanvas";

const NO_PAGES: CanvasPage[] = [];

/** The canvas for one conversation: whether it is on, which page it shows,
 *  and the effect that keeps the stage's canvas pane in step. The pane is
 *  driven only while this conversation is the one in view. */
export function useSessionCanvas(conversationId: string | null) {
  const s = useTrackedStore([
    (st) => st.clientStateInitialized,
    (st) => (conversationId ? st.clientState.ui?.session_canvas?.[conversationId] : undefined),
    (st) => (conversationId ? (st as any).conversationPages?.[conversationId]?.pages : undefined),
    (st) => {
      const rows = conversationId ? (st as any).conversationPages?.[conversationId]?.pages : undefined;
      return (rows ?? []).map((p: CanvasPage) => {
        const info: PageInfo | undefined = (st as any).pageEmbeds?.[p.slug];
        return `${p.slug}:${info ? (info.missing ? "x" : `${info.version ?? ""}${pageGateKeys(info)}`) : "?"}`;
      }).join(",");
    },
    (st) => st.currentSessionId === conversationId,
    (st) => {
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      return canvasLeafPath(tab ?? null);
    },
  ]);
  const entry = conversationId ? s.clientState.ui?.session_canvas?.[conversationId] : undefined;
  const on = !!entry;
  const pin = entry?.pin ?? null;
  const pages: CanvasPage[] = (conversationId ? (s as any).conversationPages?.[conversationId]?.pages : undefined) ?? NO_PAGES;
  const infoOf = (slug: string): (PageInfo & { gateKeys: string }) | undefined => {
    const row: PageInfo | undefined = (s as any).pageEmbeds?.[slug];
    return row ? { ...row, gateKeys: pageGateKeys(row) } : undefined;
  };
  const target = canvasTarget(pages, pin, infoOf);
  const info = target ? infoOf(target) : undefined;
  const inView = !!conversationId && s.currentSessionId === conversationId;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  const leafPath = canvasLeafPath(tab ?? null);

  // The pane waits for the page's version, so it loads once rather than
  // twice when the version arrives.
  const wantPath = on && target && info && !info.missing
    ? canvasPanePath(canvasPageUrl(target, info.version, info.gateKeys), conversationId!)
    : null;

  // Closing the pane from its own controls turns the canvas off; a pane this
  // hook took away (another session came into view) does not.
  const seen = useRef<{ id: string | null; docked: boolean }>({ id: null, docked: false });
  useWatchEffect(() => {
    if (!conversationId || !inView || !s.clientStateInitialized) return;
    if (seen.current.id !== conversationId) seen.current = { id: conversationId, docked: false };
    if (on && seen.current.docked && !leafPath) {
      seen.current.docked = false;
      setSessionCanvas(conversationId, false);
      return;
    }
    const step = planCanvas({ on, leafPath, wantPath });
    if (!applyCanvasStep(step, wantPath)) return;
    seen.current.docked = on && (step === "insert" || step === "set" || !!leafPath);
  }, [conversationId, inView, s.clientStateInitialized, on, leafPath, wantPath]);

  return { on, pin, target, pages, inView };
}
