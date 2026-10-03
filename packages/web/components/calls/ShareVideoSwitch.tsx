import { useState } from "react";
import { setCallVideoShared } from "../../hooks/useRoomRecording";
import { Switch } from "../ui/switch";
import { firstName } from "./speakers";

// Whether a call's public link shows its video too. Off unless somebody turns
// it on for this very link (convex callRecordings.shareIncludesVideo): a link
// made to share a transcript never starts handing out faces and screens
// because Record was pressed later, and a link turned off and on again starts
// without. Only the room's recording is shared, never a single person's
// screen file.
//
// Putting the video on the link publishes every face in it to anyone holding
// the link, so it is asked once in place, naming the guests it shows (people
// from outside the team who joined from a link and never chose this), and it
// is offered only to whoever may (the presser of every recording, or a team
// admin: callRecordings.setCallShareVideo). It covers the recordings made so
// far; one recorded after it waits, and the switch says so with a way to
// include it. Taking the video off is anyone's, at once.
export function ShareVideoSwitch({
  call,
  shared,
  linkOn,
  canShare = true,
  later = 0,
  guests = [],
}: {
  call: string;
  shared: boolean;
  linkOn: boolean;
  /** Whether this viewer may put the video on the link. */
  canShare?: boolean;
  /** Recordings finished after the video was put on the link, not on it yet. */
  later?: number;
  /** The names of the guests who were in the call. */
  guests?: string[];
}) {
  // `shared` is the store's (callRecordingCalls.video_shared): the switch
  // moves on the press, and a refusal puts it back and says why.
  const on = linkOn && shared;
  const [asking, setAsking] = useState(false);
  const guestWords = guestList(guests);
  const hint = !linkOn
    ? "Open the link to anyone first."
    : on
      ? `Anyone with the link can watch the room's video: every face, voice and shared screen${guestWords ? `, ${guestWords} included` : ", guests included"}.`
      : canShare
        ? "The link shows the transcript and summary only."
        : "The link shows the transcript and summary only. Only whoever recorded this call, or a team admin, can add the video.";

  if (asking && !on) {
    return (
      <div className="space-y-2 pt-1 text-xs leading-snug" role="group" aria-label="Share the video by the public link?">
        <p className="font-medium text-sol-text-secondary">Share the video with anyone who has the link?</p>
        <p className="text-sol-text-muted">
          They can watch every face, voice and shared screen in it
          {guestWords ? (
            <>
              , including <span className="text-sol-text-secondary">{guestWords}</span>, who joined as {guests.length === 1 ? "a guest" : "guests"}
            </>
          ) : null}
          . Recordings made after this stay off the link until someone adds them.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setAsking(false);
              setCallVideoShared(call, true);
            }}
            className="rounded-md bg-sol-cyan/15 px-2.5 py-1 font-medium text-sol-cyan transition-colors hover:bg-sol-cyan/25"
          >
            Share the video
          </button>
          <button
            type="button"
            onClick={() => setAsking(false)}
            className="rounded-md px-2.5 py-1 text-sol-text-muted transition-colors hover:bg-sol-text-muted/10 hover:text-sol-text"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-1">
      <label className="flex items-start gap-2.5">
        <Switch
          checked={on}
          disabled={!linkOn || (!on && !canShare)}
          aria-label="Include the video recording"
          onCheckedChange={(next) => (next ? setAsking(true) : setCallVideoShared(call, false))}
          className="mt-px"
        />
        <span className="min-w-0 text-xs leading-snug">
          <span className="block font-medium text-sol-text-secondary">Include the video recording</span>
          <span className="block text-sol-text-muted">{hint}</span>
        </span>
      </label>
      {on && later > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 pl-[46px] text-xs leading-snug text-sol-text-muted">
          <span>
            {later === 1 ? "1 later recording is" : `${later} later recordings are`} not on the link.
          </span>
          {canShare && (
            <button type="button" onClick={() => setCallVideoShared(call, true)} className="text-sol-cyan hover:underline">
              Add {later === 1 ? "it" : "them"}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** "Dana", "Dana and Eli", "Dana, Eli and 2 others": first names, distinct. */
function guestList(names: readonly string[]): string {
  const firsts = [...new Set(names.map((n) => firstName(n)).filter(Boolean))];
  if (firsts.length === 0) return "";
  if (firsts.length === 1) return firsts[0];
  if (firsts.length <= 3) return `${firsts.slice(0, -1).join(", ")} and ${firsts[firsts.length - 1]}`;
  return `${firsts.slice(0, 2).join(", ")} and ${firsts.length - 2} others`;
}
