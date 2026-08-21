// The mic button. The gesture it carries lives in hooks/useWalkie; this is only
// what a hold looks like, so the composer, a hover card and the receiver banner
// can each dress the same press differently.
import { Mic } from "lucide-react";
import { pttHoldProps, usePushToTalk } from "../../hooks/useWalkie";
import "./walkie.css";

export function WalkiePttButton({
  roomKey,
  resolveChannelId,
  label,
  className,
  title,
}: {
  roomKey: string | undefined;
  /** Called at press time, not at render: for a hover card the answer is "open
   *  the DM with this person", which must not happen merely on hover. */
  resolveChannelId: () => string | null;
  /** Absent = icon only, the composer's shape. */
  label?: string;
  className?: string;
  /** Overrides the idle tooltip; a blocked reason always wins over it. */
  title?: string;
}) {
  const ptt = usePushToTalk(roomKey, resolveChannelId);
  // The name says the GESTURE, because a hold is not a click and the word
  // "button" alone tells somebody the wrong thing about what to do with it.
  // The composer's mic is an icon with no text at all, so without this it
  // reached a screen reader as an unnamed control.
  //
  // Not aria-pressed. That is a toggle's word: it announces "toggle button, not
  // pressed" and promises a state you can latch, when what is really here is a
  // key you keep down. The state is in the name instead, where it is read as
  // part of the same breath as the gesture.
  //
  // AND IT DOES NOT SAY "TALKING" UNTIL THE MIC IS OPEN. Holding the key starts
  // a race the person cannot see: acquire the mic, join the room, unmute. That
  // took 1.0s into a warm room and 12.7s into a cold one when measured, and
  // every word said inside it reaches nobody and lands in no recording. The
  // button used to take the accent the instant the key went down, which told
  // the person to start speaking at the worst possible moment. So the keyed
  // look and the word both wait for the mic, and the gap has its own honest
  // state instead of being papered over.
  // And when the room goes away under a mic that WAS open, it says that too
  // rather than carrying on. The recording keeps running and the burst still
  // lands as a message, so this is not a failure — but nobody is hearing it,
  // and "Talking" would be a lie in the present tense.
  const opening = ptt.holding && !ptt.live && !ptt.dropped;
  const state = ptt.dropped ? "dropped" : ptt.live ? "live" : opening ? "opening" : "idle";
  const name = ptt.reason
    ? ptt.reason
    : state === "dropped"
      ? "Nobody is hearing this — still recording"
      : state === "opening"
        ? "Opening the mic — wait for it"
        : state === "live"
          ? "Talking — release to send"
          : (label ?? "Hold to talk");
  return (
    <button
      type="button"
      className={`${className ?? "ch-composer-attach"} walkie-ptt ${ptt.live ? "walkie-ptt-on" : ""} ${
        opening ? "walkie-ptt-opening" : ""
      } ${ptt.dropped ? "walkie-ptt-dropped" : ""}`}
      disabled={!!ptt.reason}
      data-walkie-ptt={roomKey ?? ""}
      data-walkie-state={state}
      aria-label={name}
      title={ptt.reason ?? title ?? "Hold to talk"}
      {...pttHoldProps(ptt)}
    >
      <Mic className="w-3.5 h-3.5" />
      {label && (
        <span>
          {state === "dropped"
            ? "Not heard"
            : state === "opening"
              ? "Opening"
              : state === "live"
                ? "Talking"
                : label}
        </span>
      )}
    </button>
  );
}
