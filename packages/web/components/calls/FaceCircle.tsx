import { Maximize2, Mic, MicOff, PhoneOff, User, Users, X } from "lucide-react";
import { useCircleFace } from "../../hooks/useCircleFace";
import { AvatarImg } from "../../lib/avatarCache";
import { firstName } from "./speakers";
import type { FacePerson, FacesMode } from "../../lib/calls/faceCrop";
import type { ParticipantTile } from "../../lib/calls/callManager";

/*
 * What a floating call LOOKS like: one person as a circle, and the four
 * controls that appear over them on hover. Nothing in this file knows which
 * window it is in, whether that window holds the call, or how big the window
 * should be — those are the host's, and keeping them apart is what lets the
 * circles be drawn, screenshotted and tested without a call existing.
 */
/**
 * The chrome. Four things, because there are exactly four things a person wants
 * from a call they have minimized: see everyone or just the talker, stop being
 * heard, get the room back, or leave.
 *
 * It draws itself over the bottom of the circles and only while the pointer is
 * in the window — the stylesheet owns both — so an idle window is its faces and
 * nothing else. What each button DOES is the caller's, because the same four
 * gestures mean different moves depending on which window is hosting them.
 */
export function FacesChrome({
  mode,
  muted,
  held,
  onMode,
  onMute,
  onRestore,
  onLeave,
}: {
  mode: FacesMode;
  muted: boolean;
  /** This window has the call, so leaving hangs up rather than just closing. */
  held: boolean;
  onMode: () => void;
  onMute: () => void;
  onRestore: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="faces-chrome" data-chrome-hit>
      {/* Every button says its word. The tooltip carries the long form. */}
      <button
        data-chrome-btn="mode"
        className="faces-btn"
        onClick={onMode}
        title={mode === "speaker" ? "Show everyone on the call" : "Show only whoever is talking"}
      >
        {mode === "speaker" ? <Users className="h-4 w-4" /> : <User className="h-4 w-4" />}
        <span className="faces-btn-word">{mode === "speaker" ? "All" : "Talker"}</span>
      </button>
      <button
        data-chrome-btn="mute"
        className={`faces-btn${muted ? " faces-btn--alert" : " faces-btn--on"}`}
        onClick={onMute}
        title={muted ? "Unmute — they hear you again" : "Mute — they stop hearing you"}
      >
        {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        <span className="faces-btn-word">{muted ? "Unmute" : "Mute"}</span>
      </button>
      <button data-chrome-btn="restore" className="faces-btn" onClick={onRestore} title="Back to the full call window">
        <Maximize2 className="h-4 w-4" />
        <span className="faces-btn-word">Window</span>
      </button>
      <button
        data-chrome-btn="leave"
        className="faces-btn faces-btn--alert"
        onClick={onLeave}
        title={held ? "Leave the call — hang up" : "Close this window — the call stays where it is"}
      >
        {held ? <PhoneOff className="h-4 w-4" /> : <X className="h-4 w-4" />}
        <span className="faces-btn-word">{held ? "Leave" : "Close"}</span>
      </button>
    </div>
  );
}

/**
 * One person, as a circle.
 *
 * With a camera, the video is cropped to their face and follows it. Without
 * one, their avatar fills the circle — a camera-off person is still somebody
 * you are talking to, and an empty circle would read as a broken video rather
 * than as a person who has their camera off.
 */
export function FaceCircle({
  person,
  tile,
  diameter,
  speaking,
  shown,
  onPointerDown,
  onPointerUp,
}: {
  person: FacePerson;
  tile?: ParticipantTile;
  diameter: number;
  speaking: boolean;
  shown: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}) {
  const { hostRef, videoRef, track } = useCircleFace({
    tile,
    image: person.image,
    diameter,
    active: shown,
  });

  return (
    // The slot is the circle's square and nothing more, so a row of them still
    // measures as circles and gaps. The name hangs out of the bottom of it,
    // which is why the slot exists at all: the circle clips its own contents,
    // and a name under the chin has to escape that clip.
    <div className="face-slot" style={{ width: diameter, height: diameter }}>
      <div
        ref={hostRef}
        data-face-hit
        // The one mark the circle carries at rest is none. Speaking is an
        // attribute rather than a class because it is a fact about the person,
        // not a variant of the component — and it reads that way in a test.
        data-speaking={speaking ? "true" : undefined}
        className={`face${shown ? " face--shown" : " face--hidden"}`}
        style={{ width: diameter, height: diameter }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <CircleFace
          videoRef={videoRef}
          track={track}
          image={person.image}
          name={person.name}
          diameter={diameter}
        />
        {person.muted && (
          <span className="face-mute">
            <MicOff className="h-3 w-3" />
          </span>
        )}
      </div>
      {/* Outside the circle, because the circle clips itself: the name hangs
          under the face, where it covers nothing, and the window grows to make
          room for it at the moment the pointer arrives. */}
      <span className="face-name">{firstName(person.name)}</span>
    </div>
  );
}


/** The contents of that circle. Paired with `useCircleFace`, which owns the
 *  refs it needs and the cropping behind both branches. */
export function CircleFace({
  videoRef,
  track,
  image,
  name,
  diameter,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  track: ParticipantTile["track"] | undefined;
  image?: string;
  name?: string;
  diameter: number;
}) {
  if (track) {
    return (
      <video ref={videoRef} autoPlay playsInline muted style={{ width: diameter, height: diameter }} />
    );
  }
  // Camera off. Their picture fills the circle — the same shape a face would
  // have, so a row of faces does not go ragged when somebody turns their
  // camera off mid-call.
  return (
    <AvatarImg
      src={image}
      alt=""
      className="face-avatar-img"
      fallback={
        <span className="face-avatar-fallback" style={{ fontSize: Math.max(12, diameter / 2.6) }}>
          {(name || "?").charAt(0).toUpperCase()}
        </span>
      }
    />
  );
}
