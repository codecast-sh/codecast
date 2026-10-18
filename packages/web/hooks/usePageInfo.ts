import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { hasStoredAuthToken } from "../lib/localAuth";
import { applyCollectionFeed, useFeederError } from "./useSyncCollection";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

/** One published page as an embed needs it (artifacts.embedInfo), kept in the store's pageEmbeds by slug. */
export type PageInfo = {
  _id: string;
  slug: string;
  /** Deleted, or never existed. */
  missing?: true;
  gated?: boolean;
  /** Gated, and this viewer has no way in: the embed links out. */
  locked?: true;
  title?: string;
  version?: number;
  kind?: string;
  /** `cast publish` stored a capture (pageThumbUrl); never set on a gated page, whose capture is not served. */
  thumb?: boolean;
  /** The gate tokens the serve route reads, for a gated page this viewer may open. */
  k?: string | null;
  e?: string | null;
};

export type PageRef = { slug: string; decision?: string | null };

const selectRows = (rows: any) => (Array.isArray(rows) ? rows.map((r) => ({ ...r, _id: r.slug })) : rows);

/** Feed pageEmbeds for these pages, in one subscription: an embed feeds its own page, a surface warms the pages it
 *  is about to show. `decision` is the decision a page was filed on, whose readers pass its gates as its owner does.
 *  A signed-in viewer waits for the server to confirm them (an answer before that would hold no gate tokens); a
 *  guest (a share page) asks at once, as anyone may. */
export function usePageEmbedFeed(pages: PageRef[]) {
  const key = pages.map((p) => `${p.slug}:${p.decision ?? ""}`).join(",");
  const authSettled = useServerAuthSettled();
  const guest = useMemo(() => !hasStoredAuthToken(), []);
  const args = useMemo(
    () => (pages.length && (authSettled || guest) ? { pages: pages.map((p) => (p.decision ? { slug: p.slug, decision: p.decision } : { slug: p.slug })) } : "skip"),
    [key, authSettled, guest], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const { data, error } = useQueryNoThrow(api.artifacts.embedInfo, args as any);
  useFeederError("artifacts.embedInfo", error);
  useConvexSync(data, useCallback((payload: any) => applyCollectionFeed("pageEmbeds", payload, selectRows), []));
  return { ready: data !== undefined, error };
}

/** The stored row for one page; undefined until it was ever fed. */
export function usePageInfoRow(slug: string): PageInfo | undefined {
  // Subscribed for re-renders; read from getState so a static render (its server snapshot is the empty initial
  // state) still paints a row the store holds.
  useTrackedStore([(st) => (st as any).pageEmbeds?.[slug]]);
  return (useInboxStore.getState() as any).pageEmbeds?.[slug];
}

/** The "&k=..&e=.." a frame or pane address needs to pass a page's gates; empty for an open page. */
export function pageGateKeys(info: PageInfo | undefined): string {
  if (!info?.gated) return "";
  return `${info.k ? `&k=${info.k}` : ""}${info.e ? `&e=${info.e}` : ""}`;
}

/** A page's info, fed and read: the row paints at once when this viewer has seen the page before. */
export function usePageInfo(slug: string, decision?: string | null) {
  const feed = usePageEmbedFeed(useMemo(() => [{ slug, decision }], [slug, decision]));
  const info = usePageInfoRow(slug);
  return { info, keys: pageGateKeys(info), ready: feed.ready, error: feed.error };
}
