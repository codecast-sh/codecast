import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

// A room's open guest links, and whether the viewer may invite into it at all.
//
// One feeder, two answers: callGuests.listGuestLinks lists the links for
// somebody who could make one and answers null for anybody else, so the same
// subscription that fills the invite panel tells the stage whether to offer
// invite, and remove (which takes the same standing). The links live in the
// `guestLinks` collection (clientSyncRegistry), keyed by link id; each push is
// the room's complete set, pruned to that room, so a link turned off from
// another window leaves this one too. Convex shares one subscription between
// every caller with the same room, so a stage, its panel and each remove
// button can all ask.

export type GuestLinkRow = {
  _id: string;
  link_id: string;
  room_key: string;
  token: string;
  path: string;
  created_by_name: string;
  mine: boolean;
  created_at: number;
  expires_at: number;
  waiting: number;
  admitted: number;
};

const rowSig = (l: GuestLinkRow) => `${l.expires_at}|${l.waiting}|${l.admitted}|${l.mine ? 1 : 0}`;
const newestFirst = (a: GuestLinkRow, b: GuestLinkRow) => b.created_at - a.created_at;

export function useGuestLinks(roomKey: string | null): {
  links: GuestLinkRow[];
  /** The first answer has landed (until then `links` is whatever the store held). */
  ready: boolean;
  /** May the viewer make links and put guests out here? null until known. */
  canInvite: boolean | null;
} {
  const feed = useMemo(
    () => ({
      select: (data: any) =>
        Array.isArray(data) ? data.map((l: any) => ({ ...l, _id: String(l.link_id), room_key: roomKey })) : null,
      syncOpts: { isDelta: true, pruneAbsentScope: (r: any) => r.room_key === roomKey },
    }),
    [roomKey],
  );
  const { ready, refused, error } = useSyncCollection(
    "guestLinks",
    api.callGuests.listGuestLinks,
    roomKey ? { room_key: roomKey } : "skip",
    feed,
  );
  const where = useMemo(() => (l: GuestLinkRow) => l.room_key === roomKey, [roomKey]);
  const links = useCollectionRows<GuestLinkRow>("guestLinks", { where, sig: rowSig, sort: newestFirst });
  return {
    links: roomKey ? links : [],
    // A list that failed to load still lets the panel make a link (the
    // mutation is the real check); a refusal is the server saying no.
    ready: ready || !!error,
    canInvite: refused ? false : ready || error ? true : null,
  };
}
