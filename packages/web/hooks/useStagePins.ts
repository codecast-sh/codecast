// What the stage of the huddle I am seated in holds beside faces and screen
// shares (convex/callStage.ts): the feeder that keeps `callStagePins` current
// for one room, and the read the stage draws from.
import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ParticipantTile } from "../lib/calls/callMedia";
import { navigateMainWindow } from "../lib/desktop";
import { pinShare, type StagePinActions } from "../lib/calls/stagePins";
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

/** What can hold a call's stage: its screen shares, then its pins newest
 *  first (so a thing just pinned takes the stage unless a share holds it or
 *  the viewer picked a tab), and what a pin's tile does outside itself. In a
 *  call's own window (`panel`) a pin opens in the main window. */
export function useStageShares(roomKey: string | null, connected: boolean, screenShares: ParticipantTile[], panel: boolean, collapse: () => void) {
  const pins = useStagePins(roomKey, connected);
  const screens = useMemo(() => [...screenShares, ...[...pins].reverse().map(pinShare)], [screenShares, pins]);
  const router = useRouter();
  const pinActions = useMemo<StagePinActions | null>(
    () =>
      roomKey
        ? {
            roomKey,
            openPath: (path) => {
              if (panel) return void navigateMainWindow(path);
              router.push(path);
              collapse();
            },
          }
        : null,
    [roomKey, panel, router, collapse],
  );
  return { pins, screens, pinActions };
}
