// The wall: everyone at once, sized by how present they are, and each face is
// the key you hold to talk to them.
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { navigateMainWindow } from "../../lib/desktop";
import { MemberFace } from "../presence/MemberFace";
import { useFaceKey } from "../presence/useFaceKey";
import {
  PRESENCE_META,
  memberDisplayName,
  memberPresenceVisual,
  presenceActivityLine,
} from "../presence/memberPresence";
import { emptyRosterText, unreadBadgeText } from "./peopleRoster";
import {
  WALL_FACE_PX,
  buildWall,
  type Wall,
  type WallFace,
  type WallTier,
} from "./peopleWallLayout";
import { usePeopleRoster, type PeopleRosterData } from "./usePeopleRoster";
import "./people.css";

/** What a face tells the surface about itself as a pointer or focus arrives:
 *  the words the wall would float under the circle, for shapes (the strip)
 *  with nowhere under a circle to float them. */
export interface FaceDescription {
  id: string;
  name: string;
  /** The activity line — or the refusal reason while a refused press shows. */
  text: string;
  /** Tailwind text class for `text`, so the tone survives the trip. */
  tone: string;
}

/** The wall, laid out from roster data — one memo shared by the wall and the
 *  strip so the two can never sort or size a team differently. */
export function useWall(data: PeopleRosterData, sizes: Record<WallTier, number> = WALL_FACE_PX): Wall<any> {
  const { members, fleets } = data;
  return useMemo(
    () =>
      buildWall(
        members,
        (m: any) => memberPresenceVisual(m),
        (m: any) => fleets.get(String(m._id)) ?? null,
        (m: any) => String(m._id ?? ""),
        (m: any) => m?.name || m?.email || "",
        sizes,
      ),
    [members, fleets, sizes],
  );
}

/**
 * A WALL, not a list.
 *
 * A buddy list sorts people into rows of equal weight, which is exactly wrong
 * about a team: at any moment two people are at their machines with work
 * running and eleven are not, and a list says all thirteen are the same. Size
 * says it instead, and it says it from across the room — the person worth a
 * word is the biggest circle on the screen before you have read a single name.
 *
 * AND THE FACE IS THE KEY. Hold it and you are talking to them: no hover, no
 * menu, no small target: the whole circle, up to 88 pixels of it. Let go under
 * a third of a second and it was a click, which opens the DM instead. That
 * doubling is only safe because the engine discards bursts under 700ms, so a
 * click can never land a burst — see WALL_TAP_MS.
 */
/** The wall with its own roster read — for the modal, which mounts only while
 *  open. The always-mounted panel uses PeopleWallView with the data it already
 *  holds, so the window never pays for a second subscription. */
export function PeopleWall({ callsEnabled }: { callsEnabled: boolean }) {
  return <PeopleWallView callsEnabled={callsEnabled} data={usePeopleRoster()} />;
}

export function PeopleWallView({
  callsEnabled,
  data,
}: {
  callsEnabled: boolean;
  data: PeopleRosterData;
}) {
  const wall = useWall(data);

  if (data.members.length === 0) {
    return (
      <div className="px-3 py-6 text-[12px] text-sol-text-dim">
        {emptyRosterText(data.strayWorkspace)}
      </div>
    );
  }

  return (
    // While a key is down the rest of the wall steps back — one person is being
    // talked to and the wall should look like it. The attribute is written once
    // per burst, from a status the list already subscribes to; nothing here
    // moves at the frame rate of a voice.
    <div className="people-wall" data-holding={data.sendingRoomKey ? "1" : undefined}>
      <div className="people-wall-cluster">
        {wall.present.map((face) => (
          <WallFaceButton key={face.id} face={face} data={data} callsEnabled={callsEnabled} />
        ))}
      </div>
      {wall.gone.length > 0 && (
        <div className="people-wall-gone">
          <div className="people-wall-gone-cluster">
            {wall.gone.map((face) => (
              <WallFaceButton key={face.id} face={face} data={data} callsEnabled={callsEnabled} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function WallFaceButton({
  face,
  data,
  callsEnabled,
  onDescribe,
}: {
  face: WallFace<any>;
  data: PeopleRosterData;
  callsEnabled: boolean;
  /** Called with the face's words as a pointer or focus arrives (and again if
   *  a refusal changes them), null as it leaves. The strip renders these in
   *  its text slot; the wall floats its own label and passes nothing. */
  onDescribe?: (d: FaceDescription | null) => void;
}) {
  const { id, member, px } = face;
  const { viewerId, now, fleets, roomFor, dmFor, talkingId } = data;
  const name = memberDisplayName(member);
  const visual = memberPresenceVisual(member);
  const fleet = fleets.get(id) ?? null;
  const room = roomFor.get(id) ?? null;
  const dm = dmFor.get(id) ?? null;
  const talking = !!id && id === talkingId;
  const line = useMemo(
    () => presenceActivityLine(member, { now, fleet, room, talking, viewerId }),
    [member, now, fleet, room, talking, viewerId],
  );

  // The DM is opened (or created) at PRESS time, never at render: pointing at a
  // wall of twenty faces must not create twenty conversations.
  const openDm = useCallback(() => {
    const channelId = useInboxStore.getState().openDmChannel([id]);
    const path = `/chat/${channelId}`;
    // The panel never navigates itself. It hands the path to the window that
    // holds the work, and only moves when there is no such window.
    if (!navigateMainWindow(path)) window.location.href = path;
  }, [id]);

  // THE FACE IS THE KEY, and it is the same key the avatar bar in the shell
  // holds — hold to talk, tap to open the conversation, a warm ring going out
  // and a cool one coming in. One hook, so the two surfaces cannot drift into
  // two answers for the same gesture.
  const key = useFaceKey({ viewerId, memberId: id, callsEnabled, talking, onTap: openDm });
  const { state, sending, refused, blocked } = key;

  // The describe channel: the same words the label under the face shows, told
  // to the surface. `attended` remembers a pointer or focus is on the face, so
  // a refusal that expires mid-hover can put the ordinary line back.
  const attended = useRef(false);
  const describe = useCallback(
    (refusedNow: boolean) => {
      if (!onDescribe || !attended.current) return;
      onDescribe({
        id,
        name,
        text: refusedNow && blocked ? blocked : line,
        tone: refusedNow && blocked ? "text-sol-red" : PRESENCE_META[visual].text,
      });
    },
    [onDescribe, id, name, blocked, line, visual],
  );
  const attend = () => {
    attended.current = true;
    describe(refused);
  };
  const unattend = () => {
    attended.current = false;
    onDescribe?.(null);
  };
  // The words follow the refusal in and out while the face is attended.
  useLayoutEffect(() => {
    describe(refused);

  }, [refused, describe]);

  const unread = dm?.unread ?? 0;

  // GROWING A FACE WITHOUT MOVING ANYBODY ELSE.
  //
  // The seat's width and height are the new size from this render on, so the
  // wrapping row re-solves exactly once. What makes it look like growth rather
  // than a jump is the scale handed to CSS here: old size over new, so the face
  // starts the frame visually where it was and the compositor walks it to full
  // size. A transform is not layout, so the neighbours hold still throughout.
  //
  // A LAYOUT effect, not an ordinary one, because it must land before the
  // browser paints. One frame at the new size followed by a snap back to the
  // old one is a flash of the very thing this avoids.
  //
  // The parity flip is what makes a SECOND change restart the growth: an
  // element already running an animation ignores being told to run the same one
  // again, so the two identical keyframes take turns. The equality guard makes
  // the effect safe to run twice, which React does in development.
  const seatRef = useRef<HTMLSpanElement | null>(null);
  const drawnPx = useRef(px);
  useLayoutEffect(() => {
    const el = seatRef.current;
    if (!el || drawnPx.current === px) return;
    el.style.setProperty("--from-scale", String(drawnPx.current / px));
    el.dataset.grow = el.dataset.grow === "a" ? "b" : "a";
    drawnPx.current = px;
  }, [px]);

  return (
    <span
      ref={seatRef}
      className="people-face-seat"
      style={{ ["--face" as string]: `${px}px` }}
      data-hold={key.holding ? "1" : undefined}
      data-refused={refused ? "1" : undefined}
      data-ask={fleet && fleet.needsYou > 0 ? "1" : undefined}
    >
      <button
        type="button"
        // Not `disabled`: a disabled button swallows the press, and the whole
        // point here is that a refused hold still answers. The state is in
        // aria-disabled, in the ring, and in the sentence under the face.
        aria-disabled={blocked ? true : undefined}
        aria-label={
          // The count belongs IN the name: the badge that draws it is decorative
          // (aria-hidden), so this sentence is the whole of what a reader gets,
          // and "3 unread" is the reason to reach for a face at all.
          `${name}.${unread > 0 ? ` ${unread} unread.` : ""}${line ? ` ${line}.` : ""} ${
            blocked ? blocked : "Hold to talk, click to open the conversation."
          }`
        }
        title={blocked ?? `Hold to talk to ${name} · click to open the DM`}
        className="people-face"
        data-tx={sending ? "1" : undefined}
        data-rx={talking ? "1" : undefined}
        data-walkie-state={state}
        {...key.keyProps}
        // The describe channel rides on top of the gesture: the face tells the
        // surface its words as a pointer or focus arrives, and takes them back
        // as it leaves. The hold's own handlers run first in every case.
        onPointerEnter={onDescribe ? attend : undefined}
        onPointerLeave={() => {
          key.keyProps.onPointerLeave?.();
          unattend();
        }}
        onFocus={() => {
          key.keyProps.onFocus?.();
          attend();
        }}
        onBlur={unattend}
      >
        <span ref={key.txRef} className="people-face-ring people-face-ring-tx" aria-hidden="true" />
        <span ref={key.rxRef} className="people-face-ring people-face-ring-rx" aria-hidden="true" />
        <MemberFace
          member={member}
          size={px}
          badgeSize={px >= 44 ? "md" : "sm"}
          title=""
          className="people-face-av"
        />
        {unread > 0 && (
          <span
            className={`people-face-unread ${dm?.muted ? "people-face-unread-muted" : ""}`}
            aria-hidden="true"
          >
            {unreadBadgeText(unread)}
          </span>
        )}
      </button>
      {/* The name and what they are doing, floating under the face rather than
          taking a row of its own: a wall of forty people cannot afford forty
          lines of text, and the one you are pointing at is the only one you are
          reading. A refused press forces it open and puts the reason there. */}
      <span className="people-face-label" aria-hidden="true">
        <span className="people-face-name">{name}</span>
        <span className={`people-face-line ${refused && blocked ? "text-sol-red" : PRESENCE_META[visual].text}`}>
          {refused && blocked ? blocked : line}
        </span>
      </span>
    </span>
  );
}
