"use client";

import { DoorOpen, Lock } from "lucide-react";
import { guestDisplayName } from "@codecast/shared/contracts";
import { Facepile } from "./OccupancyChip";
import { LiveRoomLabel } from "./LiveRoomLabel";
import { joinCall, knockRoom } from "../../lib/calls/actions";
import { useGuestsWaiting, useLiveRooms, type GuestsWaitingRow, type LiveRoomRow } from "../../hooks/useLiveRooms";

export { LiveRoomLabel };

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

/** Who is at the door, in a few words: "Ada (guest)", "Ada (guest) +2". */
function waitingNames(row: GuestsWaitingRow): string {
  const first = guestDisplayName(row.names[0] ?? "A guest");
  return row.names.length > 1 ? `${first} +${row.names.length - 1}` : first;
}

/** What a waiting row says in full, for a title and a screen reader. */
function waitingLine(row: GuestsWaitingRow): string {
  return `${waitingNames(row)} ${row.names.length > 1 ? "are" : "is"} waiting to join ${row.title ?? "your call"}`;
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
  // A guest at the door of a room nobody is in, on a link I made. That room
  // is not live (an empty room does not exist), yet somebody is standing at
  // it waiting for me, which is exactly what this cluster is for: things
  // happening now that I would want to walk into. Yellow, the guest link's
  // own colour, so it never reads as one more running huddle.
  const waiting = useGuestsWaiting();
  if (rooms.length === 0 && waiting.length === 0) return null;
  const letIn = (row: GuestsWaitingRow) => {
    void joinCall(row.roomKey, { intent: "deliberate" });
    onNavigate?.();
  };

  if (isNarrow) {
    // Icon rail: the faces ARE the row. One click walks into an open room;
    // a locked one knocks, same as the wide rail.
    return (
      <div className="flex flex-col items-center gap-1.5 py-1.5">
        {waiting.map((row) => (
          <button
            key={`waiting:${row.roomKey}`}
            type="button"
            onClick={() => letIn(row)}
            className="relative rounded-full p-1 text-sol-yellow transition-colors hover:bg-sol-yellow/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-yellow"
            aria-label={`${waitingLine(row)}. Join to let them in`}
            title={`${waitingLine(row)}. Join to let them in`}
          >
            <DoorOpen className="h-4 w-4" />
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-sol-yellow motion-reduce:animate-none" aria-hidden />
          </button>
        ))}
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
      {waiting.map((row) => (
        <div
          key={`waiting:${row.roomKey}`}
          onClick={() => letIn(row)}
          title={waitingLine(row)}
          className="flex cursor-pointer items-center gap-2 px-4 py-1 text-[12px] text-sol-text-muted hover:bg-sol-bg-highlight/60 hover:text-sol-text"
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-sol-yellow/15 text-sol-yellow">
            <DoorOpen className="h-3 w-3" />
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-sol-text">{waitingNames(row)}</span> waiting{row.title ? ` · ${row.title}` : ""}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              letIn(row);
            }}
            className="shrink-0 rounded-full border border-sol-yellow/40 bg-sol-yellow/10 px-2 py-0.5 text-[11px] font-medium text-sol-yellow opacity-90 transition-colors hover:bg-sol-yellow/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-yellow"
            aria-label={`${waitingLine(row)}. Join to let them in`}
            title="Join the call to let them in"
          >
            join
          </button>
        </div>
      ))}
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
