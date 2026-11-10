"use client";

// The Calls row of the sidebar rail, with its live-huddle dot and start-huddle button.
import { memo } from "react";
import Link from "next/link";
import { Phone, PhoneCall } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { usePoppedOut } from "../../hooks/usePoppedOut";
import { paneDragProps, railRowTone } from "../../lib/railRow";

// Calls' sidebar row. Isolated like ChatNavRow: presence heartbeats move
// teammates' `in_room_key` constantly, and that must re-render one row, not
// the rail. The live signal reads the same store fields the avatar strip
// reads — no extra query, and honest the moment anyone joins a room.
export const CallsNavRow = memo(function CallsNavRow({
  isActive,
  isNarrow,
  onMobileClose,
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
}) {
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  // Distinct occupied rooms across the roster, plus the room I'm in myself
  // (my own heartbeat may not have landed in the roster yet). Primitive
  // return, so presence churn that changes nothing re-renders nobody.
  const liveRooms = useInboxStore((s) => {
    const keys = new Set<string>();
    // The authoritative list (calls.getLiveRooms) plus the strip's view of it:
    // the union keeps the dot honest before the query has landed, and adds the
    // rooms only the server list knows about (a teammate outside my strip, a
    // huddle whose occupants hide their room key).
    for (const r of (s as any).liveRooms ?? []) keys.add(r.room_key);
    for (const m of s.teamMembers ?? []) if (m?.in_room_key) keys.add(m.in_room_key);
    if (s.call?.roomKey) keys.add(s.call.roomKey);
    return keys.size;
  });
  // Calls live in the Chat window while there is one: this row is a door.
  const away = usePoppedOut("chat");
  return (
    <div
      className={`group/calls flex items-center border-l-2 transition-colors motion-reduce:transition-none ${railRowTone(isActive && !away)}${away ? " opacity-55 hover:opacity-90" : ""}`}
    >
      <Link
        href="/calls"
        onClick={onMobileClose}
        {...paneDragProps("/calls", "Calls")}
        data-nav-row
        className={`flex-1 flex items-center ${isNarrow ? "justify-center" : "gap-3"} px-4 py-2.5 min-w-0`}
        title={away ? "Calls: opens in the Chat window" : "Calls — live huddles and transcripts"}
      >
        <span className="relative flex-shrink-0">
          <Phone className="w-5 h-5" strokeWidth={1.5} />
          {/* Narrow rail is icon-only, so the live signal rides the icon. */}
          {isNarrow && liveRooms > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-green" />
            </span>
          )}
        </span>
        {!isNarrow && (
          <>
            <span>Calls</span>
            {liveRooms > 0 && (
              <span className="relative flex h-2 w-2" aria-label="Live huddle">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-green" />
              </span>
            )}
          </>
        )}
      </Link>
      {/* Start a huddle from where you'd look for one — same modal as the
          palette's "Start Huddle", revealed on hover like the rail's other
          row actions. */}
      {!isNarrow && (
        <button
          onClick={() => openCreateModal("huddle")}
          className="p-1 mr-2 rounded text-sol-text-dim opacity-0 group-hover/calls:opacity-100 hover:text-sol-green transition-opacity"
          title="Start huddle"
        >
          <PhoneCall className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
});
