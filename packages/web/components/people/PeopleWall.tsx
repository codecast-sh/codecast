// The wall: everyone at once, sized by how present they are, and each face is
// a button with three actions under it: Talk, Ring, Message.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useEventListener } from "../../hooks/useEventListener";
import { navigateMainWindow } from "../../lib/desktop";
import { MemberFace } from "../presence/MemberFace";
import { FaceActions } from "../presence/FaceActions";
import { useFaceKey } from "../presence/useFaceKey";
import {
  PRESENCE_META,
  memberDisplayName,
  memberPresenceVisual,
  presenceActivityLine,
} from "../presence/memberPresence";
import { emptyRosterText, unreadBadgeText } from "./peopleRoster";
import { type WallFace } from "./peopleWallLayout";
import { usePeopleRoster, type PeopleRosterData } from "./usePeopleRoster";
import { useWall } from "./usePeopleWall";
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
  /** This is a refusal reason. It lands with no dwell and outlives the
   *  pointer — the wall's "a refused press is never a dead press" guarantee,
   *  carried into surfaces that speak through a slot. */
  refused?: boolean;
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
 * AND THE FACE IS A BUTTON. Click it and three labeled actions appear under
 * it — Talk, Ring, Message — so nothing about a person's circle has to be
 * guessed. No hold: a press that opened a microphone felt like an accident
 * every time, so it was turned off.
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
  onActivate,
}: {
  face: WallFace<any>;
  data: PeopleRosterData;
  callsEnabled: boolean;
  /** A surface with a slot of its own takes the click: the floating faces
   *  draw the three actions in their slot rather than under the circle. */
  onActivate?: (face: WallFace<any>) => void;
  /** Called with the face's words as a pointer or focus arrives (and again if
   *  a refusal changes them), null as it leaves. The strip renders these in
   *  its text slot; the wall floats its own label and passes nothing.
   *  A null with `ifShowing` set is a SCOPED clear — honored only while the
   *  slot still shows that face, so one face's refusal expiring cannot wipe
   *  the words of the face the pointer moved on to. */
  onDescribe?: (d: FaceDescription | null, ifShowing?: string) => void;
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

  // THE FACE IS A BUTTON WITH THREE ACTIONS UNDER IT — Talk, Ring, Message —
  // and the same face the avatar bar in the shell draws. One hook, so the two
  // surfaces cannot drift into two answers for the same click.
  const key = useFaceKey({ viewerId, memberId: id, callsEnabled, talking });
  const { state, sending, blocked } = key;

  // The actions open on a click and close on Escape, a second click, or a
  // click anywhere else. A surface with a slot of its own (the floating
  // faces) takes the click instead and draws the actions there.
  const [open, setOpen] = useState(false);
  const seatRef = useRef<HTMLSpanElement | null>(null);
  useEventListener("pointerdown", (e: Event) => {
    if (open && seatRef.current && !seatRef.current.contains(e.target as Node)) setOpen(false);
  });

  // The describe channel: the same words the label under the face shows, told
  // to the surface as a pointer or focus arrives, and taken back as it leaves.
  const attended = useRef(false);
  const describe = useCallback(() => {
    if (!onDescribe || !attended.current) return;
    onDescribe({ id, name, text: line, tone: PRESENCE_META[visual].text });
  }, [onDescribe, id, name, line, visual]);
  const attend = () => {
    attended.current = true;
    describe();
  };
  const unattend = () => {
    attended.current = false;
    onDescribe?.(null);
  };
  // The activity line moves while the face is attended; the words follow it.
  useLayoutEffect(() => {
    if (attended.current) describe();
  }, [describe]);

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
      data-ask={fleet && fleet.needsYou > 0 ? "1" : undefined}
    >
      <button
        type="button"
        aria-label={
          // The count belongs IN the name: the badge that draws it is decorative
          // (aria-hidden), so this sentence is the whole of what a reader gets.
          `${name}.${unread > 0 ? ` ${unread} unread.` : ""}${line ? ` ${line}.` : ""} Click for Talk, Ring and Message.`
        }
        aria-expanded={onActivate ? undefined : open}
        title={`${name} — click for Talk, Ring, Message`}
        className="people-face"
        // The circle IS the hit area, said in the attribute the floating
        // overlay's click-through test measures. Inert in the people window.
        data-face-hit
        data-tx={sending ? "1" : undefined}
        data-rx={talking ? "1" : undefined}
        data-walkie-state={state}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (onActivate) onActivate(face);
          else setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onPointerEnter={() => {
          key.warmProps.onPointerEnter();
          attend();
        }}
        onPointerLeave={() => {
          key.warmProps.onPointerLeave();
          unattend();
        }}
        onFocus={() => {
          key.warmProps.onFocus();
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
          showHuddle={!key.burst}
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
          reading. */}
      {!open && (
        <span className="people-face-label" aria-hidden="true">
          <span className="people-face-name">{name}</span>
          <span className={`people-face-line ${PRESENCE_META[visual].text}`}>{line}</span>
          <span className="people-face-gesture">CLICK for Talk · Ring · Message</span>
        </span>
      )}
      {/* THE THREE ACTIONS, under the face that was clicked. */}
      {open && (
        <span className="people-face-actions">
          <span className="people-face-actions-name">{name}</span>
          <FaceActions
            ptt={key.ptt}
            blocked={blocked}
            roomKey={key.roomKey}
            ringIds={[id]}
            onMessage={() => {
              setOpen(false);
              openDm();
            }}
            size="sm"
          />
        </span>
      )}
    </span>
  );
}
