import { forwardRef } from "react";
import "./ringCard.css";

export type RingInvite = {
  _id: string;
  room_key: string;
  from_name?: string;
  from_image?: string;
  anchor_title?: string;
};

/**
 * Somebody is calling. A small, calm card: who, that it is a huddle, and two
 * answers. It sits in a window pinned over every other one (the voice host's
 * ring shape, or the ring window on an older shell), over somebody's work,
 * which is exactly why it is quiet — a phone ringing on the desk, not a
 * billboard. The one moving thing is the dot beside "Incoming huddle".
 *
 * Markup and nothing else: what answering DOES depends on the window this is
 * drawn in — the host joins right here, the ring window hands the room to the
 * host — so the two gestures are the caller's.
 *
 * The ref lands on the GUTTER around the card, not the card: the shadow
 * (ringCard.css) falls outside the card's box, and both windows size
 * themselves to what they measure. Measuring the card cut the shadow off at
 * the window's edge.
 */
export const RingCard = forwardRef<
  HTMLDivElement,
  { invite: RingInvite; onAnswer: () => void; onDecline: () => void }
>(function RingCard({ invite, onAnswer, onDecline }, ref) {
  const name = invite.from_name || "Someone";
  return (
    <div ref={ref} className="ring-card-glow">
      <div className="ring-card" role="alertdialog" aria-label={`${name} wants to huddle`}>
        <div className="ring-card-head">
          {invite.from_image ? (
            <img src={invite.from_image} alt="" className="ring-card-face" />
          ) : (
            <span className="ring-card-face ring-card-face-initial" aria-hidden="true">
              {name.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="ring-card-words">
            <div className="ring-card-name">{name}</div>
            <div className="ring-card-line">
              <span className="ring-card-dot" aria-hidden="true" />
              Incoming huddle
              {invite.anchor_title && <span className="ring-card-anchor"> · {invite.anchor_title}</span>}
            </div>
          </div>
        </div>
        <div className="ring-card-actions">
          <button type="button" className="ring-card-decline" onClick={onDecline}>
            Decline
          </button>
          <button type="button" className="ring-card-join" onClick={onAnswer} autoFocus={false}>
            Join
          </button>
        </div>
      </div>
    </div>
  );
});
