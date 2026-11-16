import { useCallback, useMemo } from "react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { applyCollectionFeed, useFeederError } from "./useSyncCollection";
import { shareTokenArg } from "../lib/shareTokenScope";
import { useInboxStore } from "../store/inboxStore";
import type { GalleryPage } from "../lib/galleryItems";

const api = _typedApi as any;

/** The pages a session published, oldest first: the web header gallery and the
 *  phone's Pages chip both read this. The membership (slug, first publish)
 *  lives in conversationPages; the pages themselves live in pageEmbeds, which
 *  each caller feeds for the slugs this returns (web through usePageEmbedFeed,
 *  the phone through usePageEmbedQuery). A plain query rather than
 *  useSyncCollection: a share-link guest reads it too. `conversationId` is a
 *  Convex id or null. */
export function useSessionPages(conversationId: string | null, enabled = true): GalleryPage[] {
  const { data: pagesFeed, error: pagesError } = useQueryNoThrow(
    api.conversationPages.list,
    enabled && conversationId
      ? { conversation_id: conversationId as Id<"conversations">, ...shareTokenArg(conversationId) }
      : "skip"
  );
  useFeederError("conversationPages.list", pagesError);
  useConvexSync(pagesFeed, useCallback((row: any) => applyCollectionFeed("conversationPages", [row]), []));
  const pageRows = useInboxStore((s) => (conversationId ? (s as any).conversationPages?.[conversationId]?.pages : undefined)) as
    | Array<{ slug: string; created_at: number }>
    | undefined;
  const pages = useMemo<GalleryPage[]>(
    () => (pageRows ?? []).map((p) => ({ page: p.slug, timestamp: p.created_at })),
    [pageRows]
  );
  return pages;
}
