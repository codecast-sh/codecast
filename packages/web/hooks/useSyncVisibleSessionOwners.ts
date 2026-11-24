// The one feeder of the inbox cards' owners under the owners model: the ids
// of the cards in the viewport (lib/visibleOwnerCards), settled for a moment
// so a scroll asks once, read through sessionOwnership.listOwnersFor in
// chunks of fixed membership (lib/ownerChunks), so a scroll reads again only
// the chunks it changed, into `sessionOwners`, the home the header's own read
// fills too. A chunk whose read fails leaves its cards without faces. Mounted
// once per window.
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { isConvexId } from "../lib/entityLinks";
import { ownerCardsKey, subscribeOwnerCards } from "../lib/visibleOwnerCards";
import { rechunk, type OwnerChunk } from "../lib/ownerChunks";
import { applySessionOwnersReads } from "./useSyncSessionOwners";
import { useConvexSync } from "./useConvexSync";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useWatchEffect } from "./useWatchEffect";

const SETTLE_MS = 400;

export function useSyncVisibleSessionOwners(): void {
  const key = useSyncExternalStore(subscribeOwnerCards, ownerCardsKey, () => "");
  const [settled, setSettled] = useState(key);
  useWatchEffect(() => {
    const t = setTimeout(() => setSettled(key), SETTLE_MS);
    return () => clearTimeout(t);
  }, [key]);
  const authSettled = useServerAuthSettled();
  // Only server ids: the query takes conversation ids, and one optimistic
  // stub's key would refuse its whole chunk.
  const chunksRef = useRef<OwnerChunk[]>([]);
  const chunks = useMemo(() => (chunksRef.current = rechunk(chunksRef.current, settled.split(",").filter(isConvexId))), [settled]);
  const queries = useMemo<RequestForQueries>(
    () => (authSettled ? Object.fromEntries(chunks.map((c) => [c.key, { query: api.sessionOwnership.listOwnersFor, args: { conversation_ids: c.ids } }])) : {}),
    [chunks, authSettled],
  );
  const results = useQueries(queries);
  // One answer for every chunk that has one, the same object until one changes.
  const mergedRef = useRef<{ parts: unknown[]; data: Record<string, unknown> | undefined }>({ parts: [], data: undefined });
  const parts = chunks.map((c) => results[c.key]).filter((r) => r && !(r instanceof Error));
  const prev = mergedRef.current;
  if (parts.length !== prev.parts.length || parts.some((p, i) => p !== prev.parts[i])) {
    mergedRef.current = { parts, data: parts.length ? Object.assign({}, ...parts) : undefined };
  }
  // A read follows each session's row, so pushes come often: batched.
  useConvexSync(mergedRef.current.data, useCallback((reads: Record<string, unknown>) => applySessionOwnersReads(reads), []), { coalesceMs: 1000 });
}
