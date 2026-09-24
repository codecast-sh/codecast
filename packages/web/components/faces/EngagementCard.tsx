import { useInboxStore } from "../../store/inboxStore";
import { ENGINE_CARD_ACTIONS, sentence, type CardActions, type Incoming, type Live, type RingIn, type RingOut } from "../../lib/faces/cardActions";
// THE ENGAGEMENT CARD: the one transient control card the row needs (pl-756 F2).
//
// The model (lib/faces/faceRow) decides WHICH card is up and what it says:
// a teammate's burst playing (incoming: talk back, join live, snooze), my own
// talk or call (live: end, mute, and what the roster says about whether they
// hear me), somebody stepping in (the joined notice, same controls), a ring
// arriving (answer, decline) or a ring going out (cancel). This component draws
// that card and nothing else: no store read decides a word here, and the
// buttons hand the card back to an action so a test can watch what a press
// asks for without an engine under it.
//
// It is ONE LINE under the faces: a dot in the moment's tone, a plain
// sentence, and the buttons beside it. The strip it replaced shouted in a
// corner; a card that hangs from the header has the faces to say who, so it
// says what in one breath. The tones and button names are the strip's
// (calls/walkie.css) and the ring card's (calls/ringCard.css), compacted in
// faceRow.css, so a colour still means what it meant.
import { MicOff, Mic, PhoneOff, Video, VideoOff } from "lucide-react";
import type { FaceCard } from "../../lib/faces/faceRow";
import type { FaceDensity } from "../../lib/faces/layout";
import { WalkiePttButton } from "../calls/WalkiePtt";
import { firstName } from "../calls/speakers";
import "../calls/walkie.css";
import "../calls/ringCard.css";
import "./faceRow.css";

/** The strip's edge for a stage: warm while my voice goes out, cool while
 *  theirs comes in, both for both, and the call's violet for a line held
 *  open (ON THE LINE), the colour of the seats above it. */
function edgeOf(stage: string | undefined): string {
  switch (stage) {
    case "recording":
    case "live":
    case "opening":
    case "dropped":
      return "walkie-strip-live walkie-strip-tx";
    case "locked":
      return "walkie-strip-live walkie-strip-call";
    case "incoming":
      return "walkie-strip-live walkie-strip-rx";
    case "both":
      return "walkie-strip-live walkie-strip-tx walkie-strip-rx";
    case "mic-off":
      return "walkie-strip-denied";
    default:
      return "";
  }
}

/** "ON THE LINE · MUTED" as a sentence: "On the line · muted". The words
 *  module shouts for the retired corner strip; the row's card is one quiet
 *  line under the faces. */

/** The one line: a dot in the stage's tone, the stage as a sentence, who
 *  with, and what the roster says about who hears me. Nothing under it: the
 *  buttons beside it are the instruction. */
function Line({
  stage,
  children,
  hearing,
}: {
  stage: string;
  children: React.ReactNode;
  hearing?: Extract<FaceCard, { kind: "live" }>["hearing"];
}) {
  return (
    <div className={`walkie-stage walkie-stage-${stage}`} role="status" aria-live="polite">
      <span className="walkie-stage-dot" aria-hidden="true" />
      <span className="engagement-card-words">
        {children}
        {hearing && (
          <span className="engagement-card-hearing" data-hearing={hearing.state} title={hearing.text}>
            {" · "}
            {HEARING_SHORT[hearing.state]}
          </span>
        )}
      </span>
    </div>
  );
}

/** What the roster says about who hears me, in the strip's few words: the
 *  line already names the person, so the verdict drops the name (the whole
 *  sentence is the tooltip). */
const HEARING_SHORT: Record<"hears" | "away" | "busy", string> = {
  hears: "hears you",
  away: "away, gets it later",
  busy: "busy, gets it later",
};

/** A person's first name for the strip; a room's name ("#design") whole. */
function shortName(name: string): string {
  return name.startsWith("#") ? name : firstName(name) || name;
}

/** The stage's own words: "Talking with Ann", "On the line · muted with Ann";
 *  a bare stage (open, incoming) names the person in its hint instead. */
function Stage({
  words,
  name,
  hearing,
  muteButton = false,
}: {
  words: { stage: string; badge: string; hint: string };
  name: string;
  hearing?: Extract<FaceCard, { kind: "live" }>["hearing"];
  /** A mute button beside the line already says "muted" in red: the badge
   *  does not say it twice, and the name keeps its room. */
  muteButton?: boolean;
}) {
  const bare = words.stage === "open" || words.stage === "incoming";
  const badge = muteButton ? sentence(words.badge).replace(/ · muted$/, "") : sentence(words.badge);
  return (
    <Line stage={words.stage} hearing={hearing}>
      {bare ? (
        <span className="walkie-strip-hint">{words.stage === "incoming" ? `${shortName(name)} is talking to you` : words.hint}</span>
      ) : (
        <>
          <span className="walkie-stage-badge">{badge}</span>
          <span className="walkie-stage-with">{` with ${shortName(name)}`}</span>
        </>
      )}
    </Line>
  );
}

/** The mic and the camera as two switches on one small plate, then End. A
 *  switch is its icon: struck through and dimmed when off, lit when on, with
 *  its word in the tooltip and for a reader. */
function LiveControls({ card, actions }: { card: Live; actions: CardActions }) {
  return (
    <div className="walkie-strip-actions">
      {(card.mute || card.camera) && (
        <span className="engagement-card-toggles" role="group" aria-label="Microphone and camera">
          {card.mute && (
            <button
              type="button"
              className={`engagement-card-toggle walkie-strip-mute${card.muted ? " walkie-strip-mute-on is-off" : ""}`}
              data-card-action="mute"
              aria-pressed={!card.muted}
              aria-label={card.muted ? "Unmute" : "Mute"}
              title={card.muted ? "Unmute: they hear you again" : "Mute: they stop hearing you"}
              onClick={() => actions.mute(card)}
            >
              {card.muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            </button>
          )}
          {card.camera && (
            <button
              type="button"
              className={`engagement-card-toggle walkie-strip-camera${card.cameraOn ? "" : " is-off"}`}
              data-card-action="camera"
              aria-pressed={card.cameraOn}
              aria-label={card.cameraOn ? "Turn the camera off" : "Turn the camera on"}
              title={card.cameraOn ? "Camera off: they see your picture" : "Camera on: they see you"}
              onClick={() => actions.camera(card)}
            >
              {card.cameraOn ? <Video className="h-3.5 w-3.5" /> : <VideoOff className="h-3.5 w-3.5" />}
            </button>
          )}
        </span>
      )}
      <button type="button" className="walkie-strip-end" data-card-action="end" onClick={() => actions.end(card)}>
        <PhoneOff className="h-3.5 w-3.5" />
        End
      </button>
    </div>
  );
}

export function EngagementCard({
  card,
  density,
  actions = ENGINE_CARD_ACTIONS,
}: {
  card: FaceCard;
  density: FaceDensity;
  actions?: CardActions;
}) {
  if (card.kind === "none") return null;
  const shell = (edge: string, body: React.ReactNode) => (
    <div className={`engagement-card walkie-strip ${edge}`.trim()} data-density={density} data-card={card.kind} data-chrome-hit>
      {body}
    </div>
  );

  switch (card.kind) {
    case "incoming":
      return shell(
        edgeOf(card.words.stage),
        <>
          <Stage words={card.words} name={card.name} />
          <div className="walkie-strip-actions">
            {card.reply && (
              <WalkiePttButton
                roomKey={card.roomKey}
                // At press time, never at render: the DM is opened only when a
                // burst is about to land in it.
                resolveChannelId={() => useInboxStore.getState().openDmChannel([card.from])}
                size="sm"
                label="Talk"
                title="Talk back: click to start, click again to stop"
              />
            )}
            {card.join && (
              <button type="button" className="walkie-strip-join" data-card-action="join" onClick={() => actions.join(card)}>
                Join live
              </button>
            )}
            {card.snooze && (
              <button type="button" className="walkie-strip-snooze" data-card-action="snooze" onClick={() => actions.snooze(card)} title="Snooze the walkie for an hour">
                Snooze
              </button>
            )}
          </div>
        </>,
      );

    case "live":
      return shell(
        card.words ? edgeOf(card.words.stage) : "walkie-strip-live",
        <>
          {card.words ? (
            <Stage words={card.words} name={card.title} hearing={card.hearing} muteButton={card.mute} />
          ) : (
            <Line stage="locked" hearing={card.hearing}>
              <span className="engagement-card-title">{shortName(card.title)}</span>
            </Line>
          )}
          <LiveControls card={card} actions={actions} />
        </>,
      );

    case "joined-notice":
      return shell(
        "walkie-strip-joined",
        <>
          <Line stage="locked">
            <span className="walkie-strip-headline-lead">{card.text}</span>
          </Line>
          <LiveControls card={card} actions={actions} />
        </>,
      );

    case "ring-in":
      return shell(
        "walkie-strip-live",
        <>
          <div className="ring-card-line" role="status" aria-live="polite">
            <span className="ring-card-dot" aria-hidden="true" />
            <span className="engagement-card-words">
              <span className="engagement-card-title">{shortName(card.name)}</span> is calling
            </span>
          </div>
          <div className="ring-card-actions">
            <button type="button" className="ring-card-decline" data-card-action="decline" onClick={() => actions.decline(card)}>
              Decline
            </button>
            <button type="button" className="ring-card-join" data-card-action="answer" onClick={() => actions.answer(card)}>
              Join
            </button>
          </div>
        </>,
      );

    case "ring-out":
      return shell(
        "walkie-strip-live",
        <>
          <div className="ring-card-line" role="status" aria-live="polite">
            <span className="ring-card-dot" aria-hidden="true" />
            <span className="engagement-card-words">
              {card.status === "ringing" ? "Ringing" : sentence(card.status)} <span className="engagement-card-title">{shortName(card.name)}</span>
            </span>
          </div>
          <div className="ring-card-actions">
            <button type="button" className="ring-card-decline" data-card-action="cancel" onClick={() => actions.cancel(card)}>
              Cancel
            </button>
          </div>
        </>,
      );
  }
}
