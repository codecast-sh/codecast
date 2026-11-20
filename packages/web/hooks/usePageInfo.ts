import { useMemo } from "react";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { hasStoredAuthToken } from "../lib/localAuth";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { pageGateKeys, usePageEmbedQuery, type PageInfo, type PageRef } from "./pageEmbedQuery";

export type { PageInfo, PageRef };

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
  return usePageEmbedQuery(args);
}

/** The stored row for one page; undefined until it was ever fed. */
export function usePageInfoRow(slug: string): PageInfo | undefined {
  // Subscribed for re-renders; read from getState so a static render (its server snapshot is the empty initial
  // state) still paints a row the store holds.
  useTrackedStore([(st) => (st as any).pageEmbeds?.[slug]]);
  return (useInboxStore.getState() as any).pageEmbeds?.[slug];
}

export { pageGateKeys };

/** A page's info, fed and read: the row paints at once when this viewer has seen the page before. */
export function usePageInfo(slug: string, decision?: string | null) {
  const feed = usePageEmbedFeed(useMemo(() => [{ slug, decision }], [slug, decision]));
  const info = usePageInfoRow(slug);
  return { info, keys: pageGateKeys(info), ready: feed.ready, error: feed.error };
}
