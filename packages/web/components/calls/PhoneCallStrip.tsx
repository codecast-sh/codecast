"use client";

import { useFaceRow } from "../../hooks/useFaceRow";
import { useMediaQuery } from "../../hooks/useIsPhone";
import { useCallStageOpen } from "../../lib/calls/callStage";
import { isCallCard } from "../../lib/faces/faceRow";
import { EngagementCard } from "../faces/EngagementCard";
import { OpenCallButton } from "./OpenCallButton";
import { CallCardRecordingMark } from "./RoomRecording";

/** Below this width the top bar drops its workspace slot (TopbarRow's
 *  `hidden sm:flex`), and with it the face row and the call's card. */
const NARROW = "(max-width: 639px)";

/**
 * A call's card on a phone browser, under the header.
 *
 * On a wide screen the face row's card in the header is every call's small
 * surface: the live line, the recording mark (and its Stop), mute, End, and
 * the door to the stage. A phone's top bar has no room for the row, so that
 * card would vanish with it, and a member in a huddle with the stage closed
 * had no way to see REC, mute, hang up or get back in. This is the same card
 * (EngagementCard, with the same accessories), drawn alone on its own line
 * below the header: in the page's flow rather than floating over it, so it
 * never covers the composer or rides up with the keyboard. It is there for
 * a ring too, so a phone can answer one.
 */
export function PhoneCallStrip() {
  const narrow = useMediaQuery(NARROW);
  const stageOpen = useCallStageOpen();
  const card = useFaceRow().card;
  if (!narrow || card.kind === "none" || (stageOpen && isCallCard(card))) return null;
  return (
    <div className="phone-call-strip flex justify-center border-b border-sol-border/40 bg-sol-bg px-2 py-1" data-phone-call-strip>
      <EngagementCard
        card={card}
        density="bar"
        accessory={
          isCallCard(card) && (
            <>
              <CallCardRecordingMark />
              <OpenCallButton />
            </>
          )
        }
      />
    </div>
  );
}
