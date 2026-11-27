// The face row for React: one subscription to the shared derivation
// (lib/faces/faceRow readFaceRow), which is memoized on a signature of every
// input a face draws. A roster heartbeat, a level tick or a mute that changes
// nothing on screen hands back the same row object and this hook does not
// re-render its caller. Always mounted surfaces (the header bar) can hold it.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { idleSelfFaceOf, readFaceRow, subscribeFaceRow, type FaceEntry, type FaceRow } from "../lib/faces/faceRow";
import { useInboxStore } from "../store/inboxStore";

export type { FaceRow, FaceEntry, FaceCard, FaceState, FaceTier, Link, LinkKind } from "../lib/faces/faceRow";

export function useFaceRow(): FaceRow {
  return useSyncExternalStore(subscribeFaceRow, readFaceRow, readFaceRow);
}

/**
 * One fact off the shared row, for a surface that draws one person: a huddle
 * chip, a roster row's ring. The selector runs against the memoized row on
 * every wake and the caller renders only when its answer moves, so twenty
 * faces subscribed this way cost twenty string compares per store write and
 * no render. The answer must be a primitive: an object would be new each time.
 */
export function useFaceRowSelect<T extends string | number | boolean | null>(select: (row: FaceRow) => T): T {
  const read = useCallback(() => select(readFaceRow()), [select]);
  return useSyncExternalStore(subscribeFaceRow, read, read);
}

/** Your own face for the header while the row has none (idleSelfFaceOf).
 *  Wakes only when what the face draws changes, never on a heartbeat. */
export function useIdleSelfFace(): FaceEntry | null {
  const sig = useInboxStore((s) => {
    const f = idleSelfFaceOf(s);
    return f ? `${f.id}|${f.name}|${f.image ?? ""}|${f.state}|${f.tier}` : "";
  });
  return useMemo(() => (sig ? idleSelfFaceOf(useInboxStore.getState()) : null), [sig]);
}
