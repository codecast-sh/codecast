// The team, floating over the work: the wall's faces as a see-through row of
// circles, when there is no call.
//
// ── What this IS ──────────────────────────────────────────────────────────
// The idle half of the floating faces. In a call, the call window's circle
// sizes float the people you are talking to (CallFaces); this floats the
// people you COULD talk to — photos sized by presence, at the same spot on
// screen, so a call starting reads as the photos turning into video. Every
// face is the wall's own button: hold to talk, tap to open the DM, the rings,
// the refusal — the overlay changes the scale and nothing about the gesture.
//
// ── What it is NOT ────────────────────────────────────────────────────────
// A window with chrome. The window is a transparent rectangle that lets the
// mouse through except over a circle (useFloatingCircles, shared with the
// call's circles); everything the surface has to say beyond the faces —
// names, activity, controls — appears only under the pointer and vanishes
// with it. It also does not ring, toast, or answer anything: it is a glance,
// and the people window and the main window stay the phone.
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { GripVertical, PanelTop, Users, X } from "lucide-react";
import {
  closeFacesWindow,
  setFacesWindowContentSize,
  setFacesWindowDragging,
  setFacesWindowInteractive,
} from "../../lib/desktop";
import { popOutPeople } from "./popOutPeople";
import { useCallsAvailable } from "../../lib/teamFeatures";
import { useFloatingCircles } from "../calls/useFloatingCircles";
import { useAvatarFaceCrop } from "../calls/useAvatarFaceCrop";
import { MemberFace } from "../presence/MemberFace";
import { memberDisplayName } from "../presence/memberPresence";
import { WallFaceButton } from "./PeopleWall";
import { FaceActions } from "../presence/FaceActions";
import { useFaceKey } from "../presence/useFaceKey";
import { useEventListener } from "../../hooks/useEventListener";
import { useInboxStore } from "../../store/inboxStore";
import { navigateMainWindow } from "../../lib/desktop";
import { usePeopleRoster, type PeopleRosterData } from "./usePeopleRoster";
import { useWall } from "./usePeopleWall";
import { useDescribeSlot } from "./useDescribeSlot";
import {
  OVERFLOW_CHIP_PX,
  OVERLAY_FACE_PX,
  overlayFaces,
  overlayWindowSize,
} from "./presenceFacesLayout";
import type { WallFace } from "./peopleWallLayout";
import "../calls/faces.css";
import "./people.css";
import "./presenceFaces.css";

// Module-level for the same reason as the call window's: this component only
// ever runs inside the faces overlay window, and these are its switches.
const FACES_WINDOW_BRIDGE = {
  setInteractive: setFacesWindowInteractive,
  setContentSize: setFacesWindowContentSize,
  setDragging: setFacesWindowDragging,
};

export function PresenceFaces() {
  const data = usePeopleRoster();
  const callsEnabled = useCallsAvailable();
  // Whether the offline fold is out. Session-local on purpose: "show me
  // everyone" is a glance you take, not a mode you live in.
  const [everyone, setEveryone] = useState(false);

  const wall = useWall(data, OVERLAY_FACE_PX);
  const { shown, overflow } = useMemo(() => overlayFaces(wall, everyone), [wall, everyone]);

  // Every seat the row will draw, in px — faces plus the overflow chip — so
  // the window's size and the row's contents come from one list.
  const px = useMemo(() => {
    const sizes = shown.map((f) => f.px);
    if (overflow > 0) sizes.push(OVERFLOW_CHIP_PX);
    if (sizes.length === 0) sizes.push(OVERLAY_FACE_PX.here);
    return sizes;
  }, [shown, overflow]);

  // The face whose actions are in the slot. A second click on it, Escape, or
  // a click on the glass puts the slot back to words.
  const [active, setActive] = useState<WallFace<any> | null>(null);
  const activate = useCallback(
    (face: WallFace<any>) => setActive((cur) => (cur?.id === face.id ? null : face)),
    [],
  );
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") setActive(null);
  });

  const { rootRef, hovered, startDrag, endDrag } = useFloatingCircles({
    // While a face's actions are in the slot the window stays at its hover
    // size whether or not the pointer is over a circle — the buttons must not
    // be cut off by a window shrinking under them.
    sizeFor: (hover) => overlayWindowSize(px, { hovered: hover || !!active, actions: !!active }),
    shapeSig: `${px.join(",")}|${overflow}|${active?.id ?? ""}`,
    bridge: FACES_WINDOW_BRIDGE,
  });

  // The hovered face's words — the overlay has no room under a face for the
  // wall's label, so faces describe themselves into the slot above the chrome.
  const { desc, onDescribe } = useDescribeSlot();

  return (
    <div
      ref={rootRef}
      className={`faces-window presence-faces${hovered || active ? " faces-window--hover" : ""}`}
      data-holding={data.sendingRoomKey ? "1" : undefined}
    >
      <div className="presence-row">
        {shown.length === 0 ? (
          // Nobody else yet. Your own face is the honest picture of a team of
          // one — an empty invisible window would read as broken, or worse,
          // as nothing at all.
          <OverlaySeat px={OVERLAY_FACE_PX.here} src={data.me?.image || data.me?.github_avatar_url}>
            <span
              data-face-hit
              className="presence-me"
              onPointerDown={startDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <MemberFace
                member={data.me ?? {}}
                size={OVERLAY_FACE_PX.here}
                title={`${memberDisplayName(data.me ?? {})} · just you here`}
              />
            </span>
          </OverlaySeat>
        ) : (
          shown.map((face) => (
            <OverlayFace
              key={face.id}
              face={face}
              data={data}
              callsEnabled={callsEnabled}
              onDescribe={onDescribe}
              onActivate={activate}
            />
          ))
        )}
        {overflow > 0 && (
          <button
            type="button"
            className="presence-chip"
            data-face-hit
            style={{ width: OVERFLOW_CHIP_PX, height: OVERFLOW_CHIP_PX }}
            title={`${overflow} more — open the full people list`}
            aria-label={`${overflow} more teammates. Open the full people list.`}
            onClick={() => void popOutPeople({ list: true })}
          >
            +{overflow}
          </button>
        )}
      </div>

      {/* The card, in the band the window grows on hover. One card says
          everything the overlay says beyond the faces: a CLICKED face puts
          its three actions here — Talk, Ring, Message — under its name; a
          face merely pointed at shows its name and activity; nothing pointed
          at shows the one line of instructions. The window's own controls
          are its footer, so hovering opens one thing, not a stack of pills. */}
      <div
        className="presence-card"
        data-chrome-hit
        data-actions={active ? "1" : undefined}
        data-refused={!active && desc?.refused ? "1" : undefined}
      >
        {active ? (
          <div className="presence-card-head">
            <span className="presence-card-name">{memberDisplayName(active.member)}</span>
            <ActiveFaceActions face={active} data={data} callsEnabled={callsEnabled} onDone={() => setActive(null)} />
          </div>
        ) : desc ? (
          <div className="presence-card-head" aria-hidden="true">
            <span className="presence-card-row">
              <span className="presence-card-name">{desc.name}</span>
              <span className={`presence-card-line ${desc.tone}`}>{desc.text}</span>
            </span>
            <span className="presence-card-hint">Click for Talk · Ring · Message</span>
          </div>
        ) : (
          <div className="presence-card-head presence-card-legend" aria-hidden="true">
            <span className="presence-card-hint">Click a face for Talk · Ring · Message</span>
          </div>
        )}

        <div className="faces-chrome">
          <button
            data-chrome-btn="drag"
            className="faces-btn presence-grip"
            title="Drag to move"
            aria-label="Drag to move the faces"
            onPointerDown={startDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <GripVertical className="h-4 w-4" />
            <span className="faces-btn-word">Drag</span>
          </button>
          <button
            data-chrome-btn="everyone"
            className={`faces-btn${everyone ? " faces-btn--on" : ""}`}
            onClick={() => setEveryone((v) => !v)}
            aria-pressed={everyone}
            title={everyone ? "Showing everyone — click to show only who's around" : "Showing who's around — click to show everyone"}
          >
            <Users className="h-4 w-4" />
            <span className="faces-btn-word">{everyone ? "Here" : "All"}</span>
          </button>
          <button
            data-chrome-btn="people"
            className="faces-btn"
            onClick={() => void popOutPeople({ list: true })}
            title="Open the full people list in a window"
          >
            <PanelTop className="h-4 w-4" />
            <span className="faces-btn-word">List</span>
          </button>
          <button
            data-chrome-btn="close"
            className="faces-btn faces-btn--alert"
            onClick={() => void closeFacesWindow()}
            title="Close the floating faces"
          >
            <X className="h-4 w-4" />
            <span className="faces-btn-word">Close</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** One seat: the wall's own button, wrapped so the overlay can centre the
 *  photo on the face. The crop targets the img the seat renders — behind
 *  AvatarImg an unreachable picture renders a fallback instead, which the
 *  hook treats as the ordinary answer it is.
 *
 *  Memoized for the same reason the strip's row is: a hover writes overlay
 *  state, and re-rendering a row of push-to-talk buttons to grow the window
 *  is exactly the waste the wall's rules forbid. Every prop is stable between
 *  roster wakes — `face` from useWall's memo, `data` from usePeopleRoster's,
 *  `onDescribe` from useDescribeSlot's useCallback. */
const OverlayFace = memo(function OverlayFace({
  face,
  data,
  callsEnabled,
  onDescribe,
  onActivate,
}: {
  face: WallFace<any>;
  data: PeopleRosterData;
  callsEnabled: boolean;
  onDescribe: Parameters<typeof WallFaceButton>[0]["onDescribe"];
  onActivate: (face: WallFace<any>) => void;
}) {
  const src = face.member?.image || face.member?.github_avatar_url;
  return (
    <OverlaySeat px={face.px} src={src}>
      <WallFaceButton
        face={face}
        data={data}
        callsEnabled={callsEnabled}
        onDescribe={onDescribe}
        onActivate={onActivate}
      />
    </OverlaySeat>
  );
});

/** The clicked face's three actions, in the slot. Its own component so the
 *  face key hook (rings, room, blocked reason) mounts only while a face is
 *  active — one hook, not one per circle plus one. */
function ActiveFaceActions({
  face,
  data,
  callsEnabled,
  onDone,
}: {
  face: WallFace<any>;
  data: PeopleRosterData;
  callsEnabled: boolean;
  onDone: () => void;
}) {
  const key = useFaceKey({ viewerId: data.viewerId, memberId: face.id, callsEnabled, talking: data.talkingId === face.id });
  return (
    <FaceActions
      ptt={key.ptt}
      blocked={key.blocked}
      roomKey={key.roomKey}
      ringIds={[face.id]}
      onMessage={() => {
        onDone();
        const channelId = useInboxStore.getState().openDmChannel([face.id]);
        const path = `/chat/${channelId}`;
        if (!navigateMainWindow(path)) window.location.href = path;
      }}
      size="sm"
    />
  );
}

function OverlaySeat({
  px,
  src,
  children,
}: {
  px: number;
  src: string | null | undefined;
  children: React.ReactNode;
}) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  useAvatarFaceCrop({ hostRef, src, active: true, diameter: px });
  return (
    <span ref={hostRef} className="presence-seat">
      {children}
    </span>
  );
}
