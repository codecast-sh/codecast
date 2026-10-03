"use client";

import { useState } from "react";
import { Lock, Unlock } from "lucide-react";
import { AvatarImg } from "../../lib/avatarCache";
import { useTrackedStore, type RoomKnock } from "../../store/inboxStore";
import { admitKnock } from "../../lib/calls/callManager";
import { useRoomLock } from "../../hooks/useLiveRooms";
import { firstName } from "./speakers";
import { GuestTag } from "./GuestTag";
import { admitGuest, denyGuest } from "../../lib/calls/guestDoorActions";

/** Whose link brought a guest, as the door says it. */
function linkOf(k: RoomKnock): string {
  return k.link_mine ? "your link" : `${firstName(k.link_by)}'s link`;
}

// The door of the room you are IN: the lock that turns an open room private,
// and the people knocking to be let into it. Both live in the dock and the
// stage header, because the door belongs to whoever is inside.

// The lock button. The state and the gesture live in useRoomLock (hooks/), so
// the stage header can draw its own chrome from the same source and the lock
// can never mean two things.
export function RoomLockButton({ roomKey }: { roomKey: string }) {
  const { locked, toggle, title } = useRoomLock(roomKey);
  return (
    <button
      onClick={toggle}
      className={`rounded-md p-1.5 transition-colors ${
        locked
          ? "bg-sol-violet/15 text-sol-violet"
          : "text-sol-text-muted hover:bg-sol-bg-highlight"
      }`}
      title={title}
      // aria-pressed is right HERE — unlike push to talk, this is a genuine
      // click-to-latch toggle. But the glyph is the whole button, so without a
      // name it announced as an unlabelled toggle.
      aria-label={locked ? "Locked — click to open the room" : "Open room — click to lock it"}
      aria-pressed={locked}
    >
      {locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
    </button>
  );
}

/** Who is at the door. Renders nothing when nobody is — a knock is a moment,
 *  not a queue. Admit rings a teammate in: the accepted ring is their grant,
 *  so the room stays locked to everyone else. A guest (a stranger on a link)
 *  is let in with callGuests.admitGuest instead, under the name the door is
 *  showing, and may be turned away; a guest's knock wears the guest mark and
 *  says whose link brought them, and a link that keeps bringing people the
 *  room turned away offers to close. A guest's answer is a store action
 *  (lib/calls/guestDoorActions): the knock leaves this list, the toast and
 *  every other window's door in the frame it is pressed. */
export function RoomKnocks({ roomKey }: { roomKey: string }) {
  const s = useTrackedStore([
    // created_at is part of the signature, not decoration: a re-knock PATCHES
    // the same server row (calls.knock refreshes rather than duplicates), so
    // the second knock at the door IS a created_at change and nothing else.
    // Keyed by the person alone, this surface would never learn about it.
    // A guest's name is in it too: a guest asking under a new name is a new
    // knock, and Admit must carry the name the door shows.
    (st: any) =>
      (st.roomKnocks ?? [])
        .map((k: RoomKnock) => `${k.from_user}:${k.created_at}:${k.from_name}:${k.can_answer === false ? 0 : 1}:${k.link_turned_away ?? 0}:${k.link_by ?? ""}`)
        .join("|"),
  ]);
  const knocks: RoomKnock[] = s.roomKnocks ?? [];
  // A teammate's knock is answered with a ring (callManager.admitKnock), and
  // their row stays in the query until the knock expires or they walk in, so
  // remember WHEN we rang them and hide the row until a newer knock outranks
  // it: an impatient second click must not ring someone twice, and a genuine
  // second knock must still be visible. A guest's answer needs none of this:
  // it leaves the store's list itself.
  const [rang, setRang] = useState<Record<string, number>>({});
  const waiting = knocks.filter((k) => k.kind === "guest" || (rang[String(k.from_user)] ?? 0) < k.created_at);

  // Somebody arriving at the door is a moment, and it was a silent one: this
  // appeared as a coloured row and nothing else, so a person hosting a locked
  // room with a screen reader had no way to learn anyone was waiting short of
  // re-scanning the page. The region is mounted even when empty — a live
  // region that appears with its content already in it is the case screen
  // readers handle least reliably.
  return (
    <div
      role="status"
      aria-live="polite"
      className={waiting.length ? "flex flex-col gap-1 px-2 py-1" : undefined}
    >
      {waiting.map((k) => {
        const guest = k.kind === "guest" && !!k.guest_id;
        const name = guest ? k.from_name : firstName(k.from_name);
        const canAnswer = k.can_answer !== false;
        return (
          <div
            key={String(k.from_user)}
            className={`flex flex-col gap-1 rounded-md border px-2 py-1 ${
              guest ? "border-sol-yellow/30 bg-sol-yellow/[0.08]" : "border-sol-violet/30 bg-sol-violet/10"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="inline-block h-5 w-5 shrink-0 overflow-hidden rounded-full">
                <AvatarImg
                  src={k.from_image}
                  alt=""
                  className="h-full w-full object-cover"
                  fallback={
                    <span className="flex h-full w-full items-center justify-center bg-sol-base02 text-[9px]">
                      {(k.from_name || "?").charAt(0).toUpperCase()}
                    </span>
                  }
                />
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-sol-text-muted">
                <span
                  className="min-w-0 truncate"
                  title={guest ? `${k.from_name}, a guest from outside the team${k.link_by ? `, on ${linkOf(k)}` : ""}` : undefined}
                >
                  {name} {canAnswer ? "wants to join" : "is waiting"}
                </span>
                {guest && <GuestTag />}
                {/* Whose link: with several out, an expected guest and a
                    link that got away look the same otherwise. It gives up
                    its width first: on a narrow door (the stage's corner)
                    who is asking matters more than whose link they hold,
                    which the name's title still carries. */}
                {guest && k.link_by && <span className="min-w-0 shrink-[999] truncate text-sol-text-dim">· via {linkOf(k)}</span>}
              </span>
              {canAnswer && guest && (
                <button
                  onClick={() => denyGuest(k.guest_id!)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-sol-text-muted transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
                  aria-label={`Turn ${name} away`}
                  title="Not now. They can ask again in a minute"
                >
                  Deny
                </button>
              )}
              {canAnswer && (
                <button
                  onClick={() => {
                    if (guest) return admitGuest(k.guest_id!, k.from_name);
                    setRang((prev) => ({ ...prev, [String(k.from_user)]: k.created_at }));
                    void admitKnock(roomKey, String(k.from_user));
                  }}
                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    guest
                      ? "bg-sol-yellow/20 text-sol-yellow hover:bg-sol-yellow/30"
                      : "bg-sol-violet/20 text-sol-violet hover:bg-sol-violet/30"
                  }`}
                  aria-label={`Admit ${name}`}
                >
                  Admit
                </button>
              )}
            </div>
            {/* A link that already brought somebody the room turned away is
                probably out in the world: offer to close it with this answer. */}
            {canAnswer && guest && (k.link_turned_away ?? 0) >= 1 && (
              <div className="flex items-center gap-2 pl-7 text-[10.5px] text-sol-text-dim">
                <span className="min-w-0 flex-1 truncate">
                  {k.link_turned_away} turned away from this link already
                </span>
                <button
                  onClick={() => denyGuest(k.guest_id!, { revokeLink: true })}
                  className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-sol-red/10 hover:text-sol-red"
                  title="Turn them away and turn the link off, so nobody new can use it"
                >
                  Deny and turn off link
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
