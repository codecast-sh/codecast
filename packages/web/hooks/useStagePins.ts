// What the stage of the huddle I am seated in holds beside faces and screen
// shares (convex/callStage.ts): the feeder that keeps `callStagePins` current
// for one room, and the read the stage draws from.
import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

export type StagePinRow = {
  _id: string;
  room_key: string;
  ref: string;
  kind: "doc" | "page" | "object";
  doc_id: string | null;
  slug: string | null;
  at: number;
  title: string | null;
  doc_type: string | null;
  readable: boolean;
  pinned_by: string;
  pinned_by_name: string | null;
  pinned_by_session: string | null;
  pinned_by_agent: string | null;
};

const pinSig = (r: StagePinRow) => `${r.ref}:${r.at}:${r.title ?? ""}:${r.doc_type ?? ""}:${r.readable}:${r.pinned_by_agent ?? ""}`;
const oldestFirst = (a: StagePinRow, b: StagePinRow) => a.at - b.at;

/** Feed the room's pins while `connected`, and read them, oldest first. */
export function useStagePins(roomKey: string | null, connected: boolean): StagePinRow[] {
  const dropAbsent = useCallback((row: any) => row?.room_key === roomKey, [roomKey]);
  useSyncCollection("callStagePins", api.callStage.listPins, roomKey && connected ? { room_key: roomKey } : "skip", { dropAbsent });
  const where = useCallback((r: StagePinRow) => r.room_key === roomKey, [roomKey]);
  return useCollectionRows<StagePinRow>("callStagePins", { where, sig: pinSig, sort: oldestFirst });
}
