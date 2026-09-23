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
// It wears the walkie strip's skin (calls/walkie.css) and the ring card's
// buttons (calls/ringCard.css), because it replaces both and the person must
// not learn a second look for the same moment.
import { MicOff, Mic, PhoneOff } from "lucide-react";
import type { FaceCard } from "../../lib/faces/faceRow";
import type { FaceDensity } from "./FaceRow";
import { WalkiePttButton } from "../calls/WalkiePtt";
import { acceptInvite, cancelOutgoing, declineInvite, leaveCall, setMuted } from "../../lib/calls/callManager";
import { endWalkie, getWalkieStatus, joinWalkieLive, shutWalkieDoor } from "../../lib/calls/walkie";
import { useInboxStore } from "../../store/inboxStore";
import "../calls/walkie.css";
import "../calls/ringCard.css";
import "./faceRow.css";

type Incoming = Extract<FaceCard, { kind: "incoming" }>;
type Live = Extract<FaceCard, { kind: "live" | "joined-notice" }>;
type RingIn = Extract<FaceCard, { kind: "ring-in" }>;
type RingOut = Extract<FaceCard, { kind: "ring-out" }>;

/** What each button asks for. The engine's answers are `ENGINE_CARD_ACTIONS`;
 *  a test hands in its own and reads what was pressed. */
export type CardActions = {
  join: (card: Incoming) => void;
  snooze: (card: Incoming) => void;
  end: (card: Live) => void;
  /** Toggles: the card says whether it is muted now. */
  mute: (card: Live) => void;
  answer: (card: RingIn) => void;
  decline: (card: RingIn) => void;
  cancel: (card: RingOut) => void;
};

/** An hour: the walkie's snooze, the same number the strip's Snooze wrote. */
export const WALKIE_SNOOZE_MS = 60 * 60 * 1000;

/** The buttons, wired to the engine. A ring's invite row is looked up by the
 *  room and the person the model named, because the model carries no ids. */
export const ENGINE_CARD_ACTIONS: CardActions = {
  join: (c) => void joinWalkieLive(c.roomKey, { name: c.name }),
  // SNOOZE: the mic closes, the seat goes back (which is what stops the
  // voice), and the hour is written so the door stays shut everywhere.
  snooze: () => {
    useInboxStore.getState().snoozeWalkie(Date.now() + WALKIE_SNOOZE_MS);
    void setMuted(true, { remember: false });
    shutWalkieDoor();
  },
  // END: the walkie's own End while it holds the room (no linger after a hang
  // up); an ordinary leave for a huddle.
  end: (c) => {
    if (getWalkieStatus().liveRoom?.key === c.roomKey) void endWalkie();
    else void leaveCall();
  },
  mute: (c) => void setMuted(!c.muted),
  answer: (c) => {
    const inv = inviteIn(c);
    if (inv) void acceptInvite(String(inv._id), c.roomKey);
  },
  decline: (c) => {
    const inv = inviteIn(c);
    if (inv) void declineInvite(String(inv._id));
  },
  cancel: (c) => {
    const inv = inviteOut(c);
    if (inv) void cancelOutgoing(String(inv._id));
  },
};

function inviteIn(c: RingIn): { _id: unknown } | undefined {
  const rows: any[] = useInboxStore.getState().myCalls?.incoming ?? [];
  return rows.find((r) => r.room_key === c.roomKey && String(r.from_user) === c.from);
}

function inviteOut(c: RingOut): { _id: unknown } | undefined {
  const rows: any[] = useInboxStore.getState().myCalls?.outgoing ?? [];
  return rows.find((r) => r.room_key === c.roomKey && String(r.to_user) === c.to);
}

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

/** The loud word, then the sentence under it, from walkieStageWords. What
 *  the roster says about who hears me (`children`) sits between the two:
 *  the fact first, the instruction after, the order the strip read in. */
function Stage({
  words,
  name,
  children,
}: {
  words: { stage: string; badge: string; hint: string };
  name: string;
  children?: React.ReactNode;
}) {
  const bare = words.stage === "open" || words.stage === "incoming";
  return (
    <>
      <div className={`walkie-stage walkie-stage-${words.stage}`} role="status" aria-live="polite">
        <span className="walkie-stage-dot" aria-hidden="true" />
        <span className="walkie-stage-badge">{words.badge}</span>
        <span className="walkie-stage-with">{bare ? "" : `with ${name}`}</span>
      </div>
      {children}
      <div className="walkie-strip-hint">{words.hint}</div>
    </>
  );
}

/** "Riley hears you", in the words the roster decided (senderHearing). */
function Hearing({ hearing }: { hearing: Extract<FaceCard, { kind: "live" }>["hearing"] }) {
  if (!hearing) return null;
  return (
    <div className="engagement-card-hearing" data-hearing={hearing.state} role="status" aria-live="polite">
      {hearing.text}
    </div>
  );
}

function LiveControls({ card, actions }: { card: Live; actions: CardActions }) {
  return (
    <div className="walkie-strip-actions">
      {card.mute && (
        <button
          type="button"
          className={`walkie-strip-mute${card.muted ? " walkie-strip-mute-on" : ""}`}
          data-card-action="mute"
          aria-pressed={card.muted}
          onClick={() => actions.mute(card)}
        >
          {card.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {card.muted ? "Unmute" : "Mute"}
        </button>
      )}
      <button type="button" className="walkie-strip-end" data-card-action="end" onClick={() => actions.end(card)}>
        <PhoneOff className="h-4 w-4" />
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
                size="lg"
                label="Talk back"
                title="Talk back: click to start, click again to stop"
              />
            )}
            {card.join && (
              <button type="button" className="walkie-strip-join" data-card-action="join" onClick={() => actions.join(card)}>
                Join live
              </button>
            )}
            {card.snooze && (
              <button type="button" className="walkie-strip-snooze" data-card-action="snooze" onClick={() => actions.snooze(card)}>
                Snooze for an hour
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
            <Stage words={card.words} name={card.title}>
              <Hearing hearing={card.hearing} />
            </Stage>
          ) : (
            <>
              <div className="engagement-card-title">{card.title}</div>
              <Hearing hearing={card.hearing} />
            </>
          )}
          <LiveControls card={card} actions={actions} />
        </>,
      );

    case "joined-notice":
      return shell(
        "walkie-strip-joined",
        <>
          <div className="walkie-strip-headline walkie-strip-headline-lead" role="status" aria-live="polite">
            {card.text}
          </div>
          <LiveControls card={card} actions={actions} />
        </>,
      );

    case "ring-in":
      return shell(
        "walkie-strip-live",
        <>
          <div className="engagement-card-title">{card.name}</div>
          <div className="ring-card-line">
            <span className="ring-card-dot" aria-hidden="true" />
            Incoming huddle
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
          <div className="engagement-card-title">{card.name}</div>
          <div className="ring-card-line" role="status" aria-live="polite">
            <span className="ring-card-dot" aria-hidden="true" />
            {card.status === "ringing" ? "Ringing" : card.status}
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
