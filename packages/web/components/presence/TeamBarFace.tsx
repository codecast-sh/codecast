// One teammate in the shell's avatar bar. Its own module, and not a slice of
// the bar, because the face is the walkie key now: the gesture, the two rings
// and the join badge are the thing under test, and a test of them should not
// have to stand up a Convex query, a router and a context menu to reach it.
import { useRouter } from "next/navigation";
import { useInboxStore } from "../../store/inboxStore";
import { useOpenDm } from "../../hooks/useChatSync";
import { memberDisplayName } from "./memberPresence";
import { MemberFace } from "./MemberFace";
import { useRef, useState } from "react";
import { useEventListener } from "../../hooks/useEventListener";
import { FaceActions } from "./FaceActions";
import { useFaceKey, useRecentJoin, type WalkieFaces } from "./useFaceKey";
import "../calls/walkie.css";
import "../people/people.css";

/**
 * ONE TEAMMATE IN THE BAR, AND THE FACE IS THE KEY.
 *
 * Hold it and you are talking to them; let go under a third of a second and it
 * was a click, which opens the DM. Exactly the people wall's gesture, from the
 * same hook — the founder's complaint was that the walkie in this bar lived
 * inside a hover card that only appears after a pointer dwells for 120ms, on a
 * surface where the six faces are right there.
 *
 * AND THE BAR SHOWS THE FLOW. The warm ring is this machine's microphone going
 * out to them, the cool one is their voice arriving, and "joined" says the
 * moment the burst became a call. All three are written onto elements as
 * attributes and one CSS custom property, so a voice moves a gradient and never
 * a React tree.
 */
export function TeamBarFace({
  member,
  viewerId,
  callsEnabled,
  selected,
  faces,
  card,
  onHoverEnter,
  onHoverLeave,
  onContextMenu,
}: {
  member: any;
  viewerId: string;
  callsEnabled: boolean;
  selected: boolean;
  faces: WalkieFaces;
  /** The hover card, mounted by the bar only while this face is pointed at. */
  card: React.ReactNode;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const router = useRouter();
  const openDm = useOpenDm();
  const id = String(member._id);
  const name = memberDisplayName(member);
  const isSelf = id === viewerId;
  const talking = !!faces.talkingId && faces.talkingId === id;

  const key = useFaceKey({
    viewerId,
    memberId: id,
    callsEnabled: callsEnabled && !isSelf,
    talking,
  });
  const joined = useRecentJoin(key.roomKey, faces.joinedRoom);
  // A click opens the three actions under the face; Escape, a second click or
  // a click anywhere else closes them.
  const [open, setOpen] = useState(false);
  const seatRef = useRef<HTMLSpanElement | null>(null);
  useEventListener("pointerdown", (e: Event) => {
    if (open && seatRef.current && !seatRef.current.contains(e.target as Node)) setOpen(false);
  });

  // A BURST IS NOT A HUDDLE. `in_huddle` is true for any live seat, so the
  // violet chip lit for three seconds of somebody's voice and read the same as
  // an hour in a call — the founder's "identical for a burst, a huddle, or
  // talking to a third party". While a burst is live with this person the chip
  // stands down and the rings say what is happening instead; the moment
  // somebody joins for real it is a call again and the chip comes back.
  const burst = (key.sending || talking) && faces.joinedRoom !== key.roomKey;

  // Your own face is not a key: there is nobody to talk to. It stays the door
  // to your profile.
  if (isSelf) {
    return (
      <span className="relative" onMouseEnter={onHoverEnter} onMouseLeave={onHoverLeave}>
        <button
          onClick={() => router.push(`/team/${member.github_username || id}`)}
          onContextMenu={onContextMenu}
          className="relative block"
          title={`${name} · you`}
        >
          <MemberFace member={member} size={32} className={selected ? SELECTED_RING : ""} />
        </button>
        {card}
      </span>
    );
  }

  return (
    <span
      ref={seatRef}
      className="people-face-seat people-bar-seat"
      style={{ ["--face" as string]: "32px" }}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      data-hold={key.holding ? "1" : undefined}
    >
      <button
        type="button"
        aria-label={`${name}. Click for Talk, Ring and Message.`}
        aria-expanded={open}
        title={`${name} — click for Talk, Ring, Message`}
        className="people-face"
        data-tx={key.sending ? "1" : undefined}
        data-rx={talking ? "1" : undefined}
        data-joined={joined ? "1" : undefined}
        data-walkie-state={key.state}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        {...key.warmProps}
        onContextMenu={onContextMenu}
      >
        <span ref={key.txRef} className="people-face-ring people-face-ring-tx" aria-hidden="true" />
        <span ref={key.rxRef} className="people-face-ring people-face-ring-rx" aria-hidden="true" />
        <MemberFace
          member={member}
          size={32}
          showHuddle={!burst}
          title=""
          className={selected ? SELECTED_RING : ""}
        />
      </button>
      {/* "hey he joined" — under the face it happened to, for four seconds. */}
      {joined && (
        <span className="people-face-joined" role="status">
          joined
        </span>
      )}
      {/* THE THREE ACTIONS, under the clicked face. The hover card stands
          down while they are open: two floating things under one face is one
          too many. */}
      {open ? (
        <span className="people-face-actions">
          <span className="people-face-actions-name">{name}</span>
          <FaceActions
            ptt={key.ptt}
            blocked={key.blocked}
            roomKey={key.roomKey}
            ringIds={[id]}
            onMessage={() => {
              setOpen(false);
              openDm([id]);
            }}
            size="sm"
          />
        </span>
      ) : (
        card
      )}
    </span>
  );
}

/** The activity filter's own ring, and the one decoration this surface adds to
 *  a face the people window does not. */
const SELECTED_RING = "rounded-full ring-2 ring-sol-cyan ring-offset-1 ring-offset-sol-bg";

