// The wall: everyone at once, sized by how present they are, and each face is
// the key you hold to talk to them.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { navigateMainWindow } from "../../lib/desktop";
import { dmRoomKey } from "@codecast/shared/contracts";
import {
  isWalkieHoldKey,
  pttHoldProps,
  usePushToTalk,
  useWalkieLevelVar,
  walkieKeyState,
} from "../../hooks/useWalkie";
import { useMountEffect } from "../../hooks/useMountEffect";
import { MemberFace } from "../presence/MemberFace";
import {
  PRESENCE_META,
  memberDisplayName,
  memberPresenceVisual,
  presenceActivityLine,
} from "../presence/memberPresence";
import { STRAY_WORKSPACE, unreadBadgeText } from "./peopleRoster";
import { buildWall, isWallTap, type WallFace } from "./peopleWallLayout";
import { usePeopleRoster, type PeopleRosterData } from "./usePeopleRoster";
import "./people.css";

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
export function PeopleWall({ callsEnabled }: { callsEnabled: boolean }) {
  const data = usePeopleRoster();
  const { members, fleets } = data;

  const wall = useMemo(
    () =>
      buildWall(
        members,
        (m: any) => memberPresenceVisual(m),
        (m: any) => fleets.get(String(m._id)) ?? null,
        (m: any) => String(m._id ?? ""),
        (m: any) => m?.name || m?.email || "",
      ),
    [members, fleets],
  );

  if (members.length === 0) {
    return (
      <div className="px-3 py-6 text-[12px] text-sol-text-dim">
        {data.strayWorkspace
          ? `${STRAY_WORKSPACE} Switch workspace in the main window.`
          : "No teammates yet."}
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

/** How long the refusal hint stays up after a press that could not open a mic.
 *  Long enough to read a short sentence, short enough that it is gone before
 *  the hand comes back. */
const REFUSAL_MS = 2200;

export function WallFaceButton({
  face,
  data,
  callsEnabled,
}: {
  face: WallFace<any>;
  data: PeopleRosterData;
  callsEnabled: boolean;
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

  const ptt = usePushToTalk(
    callsEnabled ? dmRoomKey(viewerId, id) : undefined,
    useCallback(() => useInboxStore.getState().openDmChannel([id]), [id]),
  );
  const state = walkieKeyState(ptt);
  // TWO different questions, and using one for both dimmed the face you were
  // talking to for the first tenth of a second. `sending` is the microphone
  // being OPEN, which is what lights the ring and presses the face down.
  // `ptt.holding` is the thumb being down, which starts at the press and covers
  // the opening gap before the mic answers — and that is the one the wall's
  // dimming must exempt, or the held face fades out exactly as it is pressed.
  const sending = state === "live" || state === "dropped";

  // Two rings, two subscriptions, two custom properties — because one element
  // can carry only one `--level` and both directions can be true at once (you
  // hold their face while their own burst is still playing). Each ring owns its
  // ref, so the warm one follows this machine's microphone and the cool one
  // follows their voice, with no React render in either loop.
  const txRef = useWalkieLevelVar<HTMLSpanElement>(sending);
  const rxRef = useWalkieLevelVar<HTMLSpanElement>(talking, id);

  // Which gesture just happened. `performance.now()` rather than Date.now():
  // a duration must not be at the mercy of the system clock being corrected
  // mid-press.
  const downAt = useRef(0);
  const [refused, setRefused] = useState(false);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refuse = useCallback(() => {
    setRefused(true);
    if (refusalTimer.current) clearTimeout(refusalTimer.current);
    refusalTimer.current = setTimeout(() => setRefused(false), REFUSAL_MS);
  }, []);
  useMountEffect(() => () => {
    if (refusalTimer.current) clearTimeout(refusalTimer.current);
  });

  const hold = pttHoldProps(ptt);
  const blocked = callsEnabled ? ptt.reason : "Calls are not on for this team";

  const begin = () => {
    downAt.current = performance.now();
    // A press that cannot open a mic must never be a dead press. `press` itself
    // is already a no-op here — this is only the part that SAYS so.
    if (blocked) refuse();
  };
  // A release ON the face is the gesture that can be a click. A pointer that
  // wandered off it, or a cancelled gesture, ends the hold without opening
  // anything: letting go somewhere else is how people abort.
  const finish = () => {
    if (isWallTap(downAt.current, performance.now())) openDm();
  };

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
      data-hold={ptt.holding ? "1" : undefined}
      data-refused={refused ? "1" : undefined}
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
          `${name}.${unread > 0 ? ` ${unread} unread.` : ""} ${
            blocked ? blocked : "Hold to talk, click to open the conversation."
          }`
        }
        title={blocked ?? `Hold to talk to ${name} · click to open the DM`}
        className="people-face"
        data-tx={sending ? "1" : undefined}
        data-rx={talking ? "1" : undefined}
        data-walkie-state={state}
        {...hold}
        // NO HOVER WARM on this surface, and this is the one place the wall
        // departs from the key it is built on.
        //
        // `pttHoldProps` opens the microphone when a pointer ARRIVES on a key,
        // which takes getUserMedia out of the press and makes the first burst of
        // a session as instant as the second. That is right for a 28px key you
        // aim at: pointing at it is already the gesture. It is wrong here,
        // because on the wall the faces ARE the surface — a mouse crossing the
        // window to reach anything at all sweeps four of them, and the browser's
        // recording indicator would light up because somebody moved a pointer.
        // The composer key made exactly this distinction once already, between
        // the key and the conversation; a wall of keys falls on the other side
        // of it.
        //
        // Focus still warms: tabbing onto a face is deliberate in a way that
        // passing over one is not. A pointer hold pays the device at press time
        // instead — tens of milliseconds on an already-granted mic.
        onPointerEnter={undefined}
        onPointerDown={(e) => {
          begin();
          hold.onPointerDown(e);
        }}
        onPointerUp={() => {
          hold.onPointerUp();
          finish();
        }}
        // Gated on the same key set the hold itself uses, asked of the same
        // function: without it Tab would time a press of zero milliseconds and
        // its keyup would open a DM on the way past.
        onKeyDown={(e) => {
          if (isWalkieHoldKey(e.key) && !e.repeat) begin();
          hold.onKeyDown(e);
        }}
        onKeyUp={(e) => {
          hold.onKeyUp(e);
          if (isWalkieHoldKey(e.key)) finish();
        }}
      >
        <span ref={txRef} className="people-face-ring people-face-ring-tx" aria-hidden="true" />
        <span ref={rxRef} className="people-face-ring people-face-ring-rx" aria-hidden="true" />
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
