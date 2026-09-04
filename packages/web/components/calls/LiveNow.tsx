"use client";

import { Lock } from "lucide-react";
import { Facepile } from "./OccupancyChip";
import { joinCall, knockRoom } from "../../lib/calls/actions";
import { useLiveRooms, type LiveRoomRow } from "../../hooks/useLiveRooms";

// Live now — the huddles running right now anywhere in your teams, made
// visible where you'd walk past them. A room is a door: you step through the
// ones open to you with one click (no ring, muted, like walking up to an
// occupied table), and knock at the rest. The cluster renders NOTHING when no
// huddle is live: rooms are keys, not entities, and an empty room does not
// exist.

/** What you may do about a room, as one button. Join when you may walk in,
 *  Knock when you may not, and a quiet "knocked" state while you wait to be
 *  let in — the admit ring answers itself (useCallRing), so this is the last
 *  thing the knocker has to do.
 *
 *  The lock does NOT decide that: it shuts the open door and nothing else, so
 *  the room's own people and a guest holding a live grant walk straight into a
 *  locked room — and calls.knock refuses exactly them ("this huddle is open —
 *  just join it"). Branching on the capability the server sent, rather than on
 *  the room's state, is what keeps the button from offering a gesture the
 *  server will reject. */
export function LiveRoomAction({
  row,
  className = "",
}: {
  row: LiveRoomRow;
  className?: string;
}) {
  if (row.mine) {
    return (
      <button type="button" className={`shrink-0 text-[11px] text-sol-violet ${className}`}
        title="Show the huddle window"
        aria-label={`Show ${row.label}`}
        onClick={(e) => { e.stopPropagation(); void joinCall(row.roomKey, { intent: "deliberate" }); }}>
        open huddle
      </button>
    );
  }
  if (row.canJoin) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void joinCall(row.roomKey, { intent: "deliberate" });
        }}
        className={`shrink-0 rounded-full border border-sol-violet/30 bg-sol-violet/10 px-2 py-0.5 text-[11px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-violet ${className}`}
        // The visible word is one syllable because the row already says which
        // room. A screen reader reaches this button with the row's name
        // several stops behind it, so the label carries the room itself.
        aria-label={`Join ${row.label}`}
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
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void knockRoom(row.roomKey);
      }}
      className={`shrink-0 rounded-full border border-sol-border px-2 py-0.5 text-[11px] text-sol-text-muted transition-colors hover:border-sol-violet/40 hover:text-sol-violet focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-violet ${className}`}
      aria-label={`Knock at ${row.label}`}
      title="This huddle is locked — knock to ask in"
    >
      knock
    </button>
  );
}

/** The room's name plus the lock glyph. The glyph reports the door's state
 *  honestly, including on a locked room this viewer may still walk into.
 *  Shared by the rail and the /calls rows so the two read alike. */
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
        {rooms.map((row) => {
          const glyph = (
            <>
              <Facepile members={row.members} max={2} size={16} />
              {row.locked && (
                <Lock
                  className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 text-sol-text-dim"
                  aria-label="Locked"
                />
              )}
            </>
          );
          return (
            <button
              key={row.roomKey}
              type="button"
              onClick={() => {
                if (row.mine || row.canJoin) void joinCall(row.roomKey, { intent: "deliberate" });
                else void knockRoom(row.roomKey);
                onNavigate?.();
              }}
              className="relative rounded-full p-0.5 transition-colors hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-violet"
              aria-label={row.mine ? `Show ${row.label}` : row.canJoin ? `Join ${row.label}` : `Knock at ${row.label}`}
              title={
                row.mine ? `${row.label} — show huddle` : row.canJoin
                  ? `${row.label} — join`
                  : `${row.label} — locked, knock to ask in`
              }
            >
              {glyph}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="pb-1">
      <div className="flex items-center gap-1.5 px-4 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-violet opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sol-violet" />
        </span>
        Live now
      </div>
      {/* The row carries no role and no tab stop of its own. Its click is a
          convenience for a mouse that lands anywhere on the row; the gesture
          itself belongs to the button inside it, which is the thing a keyboard
          reaches and a screen reader announces. A role="button" here would
          both nest an interactive element inside another (invalid ARIA) and
          promise a keyboard affordance the div never had. */}
      {rooms.map((row) => (
        <div
          key={row.roomKey}
          onClick={() => {
            if (!row.mine && !row.canJoin) return;
            void joinCall(row.roomKey, { intent: "deliberate" });
            onNavigate?.();
          }}
          className={`group/room flex items-center gap-2 px-4 py-1 text-[12px] text-sol-text-muted ${
            !row.mine && !row.canJoin ? "" : "cursor-pointer hover:bg-sol-bg-highlight/60 hover:text-sol-text"
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
