"use client";

import { Lock } from "lucide-react";
import { Facepile } from "./OccupancyChip";
import { joinCall, knockRoom } from "../../lib/calls/callManager";
import { useLiveRooms, type LiveRoomRow } from "../../hooks/useLiveRooms";

// Live now — the huddles running right now anywhere in your teams, made
// visible where you'd walk past them. A room is a door: an open one you step
// into with one click (no ring, muted, like walking up to an occupied table),
// a locked one you knock at. The cluster renders NOTHING when no huddle is
// live: rooms are keys, not entities, and an empty room does not exist.

/** What you may do about a room, as one button. Join for an open door, Knock
 *  for a locked one, and a quiet "knocked" state while you wait to be let in
 *  — the admit ring answers itself (useCallRing), so this is the last thing
 *  the knocker has to do. */
export function LiveRoomAction({
  row,
  className = "",
}: {
  row: LiveRoomRow;
  className?: string;
}) {
  if (row.mine) {
    return (
      <span className={`shrink-0 text-[11px] text-sol-violet ${className}`}>you're in</span>
    );
  }
  if (!row.locked) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          void joinCall(row.roomKey);
        }}
        className={`shrink-0 rounded-full border border-sol-violet/30 bg-sol-violet/10 px-2 py-0.5 text-[11px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/20 ${className}`}
        title="Join the huddle — you arrive muted"
      >
        join
      </button>
    );
  }
  if (row.knocked) {
    return (
      <span
        className={`shrink-0 rounded-full border border-sol-border/50 px-2 py-0.5 text-[11px] text-sol-text-dim ${className}`}
        title="They can see you at the door"
      >
        knocked
      </span>
    );
  }
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void knockRoom(row.roomKey);
      }}
      className={`shrink-0 rounded-full border border-sol-border px-2 py-0.5 text-[11px] text-sol-text-muted transition-colors hover:border-sol-violet/40 hover:text-sol-violet ${className}`}
      title="This huddle is locked — knock to ask in"
    >
      knock
    </button>
  );
}

/** The room's name plus the lock glyph that explains why the action says
 *  Knock. Shared by the rail and the /calls rows so the two read alike. */
export function LiveRoomLabel({ row, className = "" }: { row: LiveRoomRow; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-1 ${className}`}>
      {row.locked && <Lock className="h-3 w-3 shrink-0 text-sol-text-dim" aria-label="Locked" />}
      <span className={`min-w-0 truncate ${row.redacted ? "italic text-sol-text-muted" : ""}`}>
        {row.label}
      </span>
    </span>
  );
}

// The sidebar cluster, mounted under the Calls row. Always mounted, so every
// store read here is a wake signature (useLiveRooms) rather than a collection.
export function LiveNowRail({
  isNarrow,
  onNavigate,
}: {
  isNarrow: boolean;
  onNavigate?: () => void;
}) {
  const rooms = useLiveRooms();
  if (rooms.length === 0) return null;

  if (isNarrow) {
    // Icon rail: the faces ARE the row. One click walks into an open room;
    // a locked one knocks, same as the wide rail.
    return (
      <div className="flex flex-col items-center gap-1.5 py-1.5">
        {rooms.map((row) => (
          <button
            key={row.roomKey}
            onClick={() => {
              if (row.mine) return;
              if (row.locked) void knockRoom(row.roomKey);
              else void joinCall(row.roomKey);
              onNavigate?.();
            }}
            className="relative rounded-full p-0.5 transition-colors hover:bg-sol-bg-highlight"
            title={
              row.mine
                ? `${row.label} — you're in`
                : row.locked
                  ? `${row.label} — locked, knock to ask in`
                  : `${row.label} — join`
            }
          >
            <Facepile members={row.members} max={2} size={16} />
            {row.locked && (
              <Lock className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 text-sol-text-dim" />
            )}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="pb-1">
      <div className="flex items-center gap-1.5 px-4 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-violet opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sol-violet" />
        </span>
        Live now
      </div>
      {rooms.map((row) => (
        <div
          key={row.roomKey}
          onClick={() => {
            if (row.mine || row.locked) return;
            void joinCall(row.roomKey);
            onNavigate?.();
          }}
          role={row.mine || row.locked ? undefined : "button"}
          className={`group/room flex items-center gap-2 px-4 py-1 text-[12px] text-sol-text-muted ${
            row.mine || row.locked ? "" : "cursor-pointer hover:bg-sol-bg-highlight/60 hover:text-sol-text"
          }`}
        >
          <Facepile members={row.members} max={3} size={18} />
          <LiveRoomLabel row={row} className="flex-1" />
          <LiveRoomAction row={row} className="opacity-90" />
        </div>
      ))}
    </div>
  );
}
