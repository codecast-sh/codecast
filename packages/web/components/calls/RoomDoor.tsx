"use client";

import { useState } from "react";
import { Lock, Unlock } from "lucide-react";
import { AvatarImg } from "../../lib/avatarCache";
import { useTrackedStore } from "../../store/inboxStore";
import { admitKnock } from "../../lib/calls/callManager";
import { useRoomLock } from "../../hooks/useLiveRooms";
import { firstName } from "./speakers";

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
 *  not a queue. Admit rings them in: the accepted ring is their grant, so the
 *  room stays locked to everyone else. */
export function RoomKnocks({ roomKey }: { roomKey: string }) {
  const s = useTrackedStore([
    // created_at is part of the signature, not decoration: a re-knock PATCHES
    // the same server row (calls.knock refreshes rather than duplicates), so
    // the second knock at the door IS a created_at change and nothing else.
    // Keyed by the person alone, this surface would never learn about it.
    (st: any) =>
      (st.roomKnocks ?? []).map((k: any) => `${k.from_user}:${k.created_at}`).join("|"),
  ]);
  const knocks: any[] = s.roomKnocks ?? [];
  // An admitted knocker's row stays in the query until their knock expires or
  // they walk in, so remember WHEN we admitted them and hide the row until a
  // newer knock outranks it — an impatient second click must not ring someone
  // twice, and a genuine second knock must still be visible.
  const [admitted, setAdmitted] = useState<Record<string, number>>({});

  const waiting = knocks.filter((k) => (admitted[String(k.from_user)] ?? 0) < k.created_at);

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
      {waiting.map((k) => (
        <div
          key={String(k.from_user)}
          className="flex items-center gap-2 rounded-md border border-sol-violet/30 bg-sol-violet/10 px-2 py-1"
        >
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
          <span className="min-w-0 flex-1 truncate text-[11px] text-sol-text-muted">
            {firstName(k.from_name)} wants to join
          </span>
          <button
            onClick={() => {
              setAdmitted((prev) => ({ ...prev, [String(k.from_user)]: k.created_at }));
              void admitKnock(roomKey, String(k.from_user));
            }}
            className="shrink-0 rounded bg-sol-violet/20 px-2 py-0.5 text-[11px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/30"
            aria-label={`Admit ${firstName(k.from_name)}`}
          >
            Admit
          </button>
        </div>
      ))}
    </div>
  );
}
