import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { applyCollectionFeed, useFeederError } from "./useSyncCollection";
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
  /** The member token of a team-gated page (regulated data), for its team's signed-in members. */
  m?: string | null;
};

export type PageRef = { slug: string; decision?: string | null };

/** The "&m=..&k=..&e=.." a frame or pane address needs to pass a page's gates; empty for an open page. */
export function pageGateKeys(info: PageInfo | undefined): string {
  if (!info?.gated) return "";
  return `${info.m ? `&m=${info.m}` : ""}${info.k ? `&k=${info.k}` : ""}${info.e ? `&e=${info.e}` : ""}`;
}

const selectRows = (rows: any) => (Array.isArray(rows) ? rows.map((r) => ({ ...r, _id: r.slug })) : rows);

/** Feeds pageEmbeds from artifacts.embedInfo once the caller says the viewer is settled. Web's usePageEmbedFeed
 *  (./usePageInfo) decides that from its stored token and the server's word; the phone, always signed in, from
 *  Convex auth. Free of web-only auth imports so the phone's bundle can reach it. */
export function usePageEmbedQuery(args: { pages: Array<{ slug: string; decision?: string }> } | "skip") {
  const { data, error } = useQueryNoThrow(api.artifacts.embedInfo, args as any);
  useFeederError("artifacts.embedInfo", error);
  useConvexSync(data, useCallback((payload: any) => applyCollectionFeed("pageEmbeds", payload, selectRows), []));
  return { ready: data !== undefined, error };
}
