// The window at its smallest: one row of faces you can hold, and the team in
// a few words. This is what a buddy list pinned above other apps should cost.
import { memo, useState, type ReactNode } from "react";
import { MemberFace } from "../presence/MemberFace";
import { LiveRoomAction } from "../calls/LiveNow";
import { emptyRosterText } from "./peopleRoster";
import { useDescribeSlot } from "./useDescribeSlot";
import { STRIP_FACE_PX, STRIP_ROW_H } from "./peopleDensity";
import { peopleHeadClass } from "./usePeopleDensity";
import { WallFaceButton, type FaceDescription } from "./PeopleWall";
import { useWall } from "./usePeopleWall";
import { TeamPulseLine } from "./TeamPulseLine";
import { type PeopleRosterData } from "./usePeopleRoster";
import { type TeamPulse } from "./teamPulse";
import "./people.css";

/**
 * THE SAME FACES AS THE WALL, in a row.
 *
 * Every face here is the wall's own button — hold to talk, tap to open the
 * DM, the rings, the refusal — at the strip's sizes instead of the wall's
 * (peopleDensity.ts). Presence still sets the size, so the biggest circle is
 * still the person most worth a word; it is only the scale that changes.
 *
 * There is no room under a face for its label in a 56px window, so each face
 * DESCRIBES itself to the strip as a pointer or focus arrives (onDescribe),
 * and those words — the activity line, or the refusal reason — take over the
 * text slot from the team pulse, and give it back on leave. The offline fold
 * into one count that opens on a click: absentees must not cost a strip its
 * row, and must not be unreachable either.
 *
 * The row is anchored to the TOP of the window at a fixed height, beside the
 * traffic lights, so a window dragged taller (but still a strip) keeps its
 * faces at the titlebar instead of floating mid-box. The row is the drag
 * surface; the faces scroller opts back out, because a drag region eats the
 * pointer events the hover words depend on.
 */
export function PeopleStrip({
  callsEnabled,
  data,
  pulse,
  pin,
}: {
  callsEnabled: boolean;
  data: PeopleRosterData;
  pulse: TeamPulse;
  /** The window's pin, rendered by the panel that owns the window state. */
  pin?: ReactNode;
}) {
  const wall = useWall(data, STRIP_FACE_PX);

  // The hovered face's words, debounced behind the shared dwell — the same
  // slot discipline the floating overlay keeps (useDescribeSlot).
  const { desc, onDescribe } = useDescribeSlot();

  return (
    <div
      className={`people-strip flex w-full min-w-0 shrink-0 items-center gap-2 pr-2 ${peopleHeadClass()}`}
      style={{ height: STRIP_ROW_H }}
      data-holding={data.sendingRoomKey ? "1" : undefined}
    >
      <MemberFace member={data.me ?? {}} size={22} title="You" className="shrink-0" />
      <span className="people-strip-rule" aria-hidden="true" />
      <StripFaces
        wall={wall}
        data={data}
        callsEnabled={callsEnabled}
        onDescribe={onDescribe}
        emptyText={data.members.length === 0 ? emptyRosterText(data.strayWorkspace, true) : null}
      />
      {/* The huddle's join, in the one shape whose pulse can name a huddle it
          would otherwise offer nothing about. */}
      {callsEnabled &&
        data.rooms.map((row) => (
          <LiveRoomAction key={row.roomKey} row={row} className="shrink-0" />
        ))}
      <div className="people-strip-words min-w-0 flex-1 overflow-hidden text-[11px]">
        {desc ? (
          <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap leading-none">
            <span className="shrink-0 font-medium text-sol-text">{desc.name}</span>
            <span className={`truncate ${desc.tone}`}>{desc.text}</span>
          </div>
        ) : (
          <TeamPulseLine pulse={pulse} />
        )}
      </div>
      {pin}
    </div>
  );
}

/**
 * The faces row, memoized behind stable props: a hover writes strip state,
 * and re-rendering fourteen push-to-talk buttons to move one line of text is
 * exactly the waste the wall's own rules forbid. `data` is referentially
 * stable between roster wakes (usePeopleRoster memoizes it), `onDescribe` is
 * a stable callback, and `wall` only changes when the roster does.
 */
const StripFaces = memo(function StripFaces({
  wall,
  data,
  callsEnabled,
  onDescribe,
  emptyText,
}: {
  wall: ReturnType<typeof useWall>;
  data: PeopleRosterData;
  callsEnabled: boolean;
  onDescribe: (d: FaceDescription | null) => void;
  emptyText: string | null;
}) {
  const [showGone, setShowGone] = useState(false);
  const goneNames = wall.gone.map((f) => f.member?.name || f.member?.email || "?").join(", ");
  if (emptyText) {
    return <span className="truncate text-[11px] text-sol-text-dim">{emptyText}</span>;
  }
  return (
    <div className="people-strip-faces flex min-w-0 shrink items-center gap-2">
      {wall.present.map((face) => (
        <WallFaceButton
          key={face.id}
          face={face}
          data={data}
          callsEnabled={callsEnabled}
          onDescribe={onDescribe}
        />
      ))}
      {wall.gone.length > 0 && (
        <button
          type="button"
          className="people-strip-gone"
          aria-expanded={showGone}
          aria-label={`${wall.gone.length} offline: ${goneNames}`}
          title={`Offline: ${goneNames}`}
          onClick={() => setShowGone((v) => !v)}
        >
          +{wall.gone.length}
        </button>
      )}
      {showGone &&
        wall.gone.map((face) => (
          <span key={face.id} className="flex shrink-0 opacity-60">
            <WallFaceButton
              face={face}
              data={data}
              callsEnabled={callsEnabled}
              onDescribe={onDescribe}
            />
          </span>
        ))}
    </div>
  );
});
