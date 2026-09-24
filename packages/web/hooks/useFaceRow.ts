// The face row for React: one subscription to the shared derivation
// (lib/faces/faceRow readFaceRow), which is memoized on a signature of every
// input a face draws. A roster heartbeat, a level tick or a mute that changes
// nothing on screen hands back the same row object and this hook does not
// re-render its caller. Always mounted surfaces (the header bar) can hold it.
//
// `ask` (a teammate's sessions waiting on the viewer) is the one field the
// shared reader leaves at zero: it is a walk of every session, and the fleet
// summaries already keep that walk behind their own wake signature, so this
// hook overlays them rather than reading the sessions a second time.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readFaceRow, subscribeFaceRow, type FaceRow } from "../lib/faces/faceRow";
import { useFleetSummaries } from "../components/presence/useMemberActivity";

export type { FaceRow, FaceEntry, FaceCard, FaceState, FaceTier, Link, LinkKind } from "../lib/faces/faceRow";

/** The asks the row's faces would show, as one string, so a fleet change
 *  that moves no face's count keeps the row's identity. My own face carries
 *  no mark: the model leaves it at zero on purpose (my sessions waiting on
 *  me are not news on my own picture), and the overlay never puts it back. */
export function askSigOf(row: FaceRow, fleets: ReadonlyMap<string, { needsYou: number }>): string {
  return row.entries.map((e) => (e.me ? 0 : (fleets.get(e.id)?.needsYou ?? 0))).join(",");
}

/** The row with the asks written on; the same row when nobody has one. */
export function overlayAsks(row: FaceRow, askSig: string): FaceRow {
  if (!/[1-9]/.test(askSig)) return row;
  const asks = askSig.split(",").map(Number);
  return { ...row, entries: row.entries.map((e, i) => (e.ask === asks[i] ? e : { ...e, ask: asks[i] })) };
}

export function useFaceRow(): FaceRow {
  const row = useSyncExternalStore(subscribeFaceRow, readFaceRow, readFaceRow);
  const fleets = useFleetSummaries();
  const askSig = askSigOf(row, fleets);
  return useMemo(() => overlayAsks(row, askSig), [row, askSig]);
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
