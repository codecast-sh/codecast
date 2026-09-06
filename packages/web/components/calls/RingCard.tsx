import { forwardRef } from "react";
import { PhoneIncoming, PhoneOff } from "lucide-react";
import "./ringCard.css";

export type RingInvite = {
  _id: string;
  room_key: string;
  from_name?: string;
  from_image?: string;
  anchor_title?: string;
};

/**
 * Somebody is calling. The one card in the app that is meant to be
 * unmissable: the caller's face, large, with a ring pulsing out of it; who
 * and what for; Join as the thing your hand goes to. It sits in a window
 * pinned over every other one (the voice host's ring shape, or the ring
 * window on an older shell), which is why it wears its own edge and shadow.
 *
 * Markup and nothing else: what answering DOES depends on the window this is
 * drawn in — the host joins right here, the ring window hands the room to the
 * host — so the two gestures are the caller's.
 */
export const RingCard = forwardRef<
  HTMLDivElement,
  { invite: RingInvite; onAnswer: () => void; onDecline: () => void }
>(function RingCard({ invite, onAnswer, onDecline }, ref) {
  const name = invite.from_name || "Someone";
  return (
    <div ref={ref} className="ring-card" role="alertdialog" aria-label={`${name} wants to huddle`}>
      <div className="ring-card-face-wrap" aria-hidden="true">
        <span className="ring-card-pulse" />
        <span className="ring-card-pulse ring-card-pulse-2" />
        {invite.from_image ? (
          <img src={invite.from_image} alt="" className="ring-card-face" />
        ) : (
          <span className="ring-card-face ring-card-face-initial">{name.charAt(0).toUpperCase()}</span>
        )}
      </div>
      <div className="ring-card-words">
        <div className="ring-card-name">{name}</div>
        <div className="ring-card-line">wants to huddle</div>
        {invite.anchor_title && <div className="ring-card-anchor">{invite.anchor_title}</div>}
      </div>
      <div className="ring-card-actions">
        <button type="button" className="ring-card-join" onClick={onAnswer} autoFocus={false}>
          <PhoneIncoming className="h-4 w-4" />
          Join
        </button>
        <button type="button" className="ring-card-decline" onClick={onDecline} title="Decline">
          <PhoneOff className="h-4 w-4" />
          Decline
        </button>
      </div>
    </div>
  );
});
