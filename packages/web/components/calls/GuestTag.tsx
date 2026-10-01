import { firstName } from "./speakers";
import { isGuestParticipant } from "../../lib/calls/roomGuests";
import { useStageHost } from "./stageHost";

// The mark a guest wears wherever the room shows people: a face, a tile's
// name chip, a door knock, a line in the thread. A guest is somebody from
// outside the team who came in on a link, and nothing about their name says
// so (it is whatever they typed), so every surface that names a participant
// asks the identity first and marks them here, in one look.
//
// Store free on purpose: the guest's own page (app/meet) draws the same
// stage with the same marks and never loads the app's store.

export function GuestTag({ className = "", title = "A guest from outside the team" }: { className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-[4px] bg-sol-yellow/15 px-1 py-px font-mono text-[9.5px] font-medium leading-none tracking-wide text-sol-yellow ring-1 ring-inset ring-sol-yellow/25 ${className}`}
    >
      guest
    </span>
  );
}

/** A participant's first name, with the guest mark when they are one. The one
 *  way a stage, a caption or a thread line names somebody in a call. */
export function PersonName({
  identity,
  name,
  you = false,
  className = "",
  tagClassName = "",
}: {
  identity?: string | null;
  name: string | undefined;
  /** Say "you" instead (the viewer's own tile). */
  you?: boolean;
  className?: string;
  tagClassName?: string;
}) {
  // The stage knows who is looking (StageHost.selfIdentity): their own row
  // says "you" wherever the views list people, not only on their own tile.
  const self = useStageHost().selfIdentity;
  you = you || (!!self && !!identity && identity === self);
  const guest = !you && isGuestParticipant(identity, name);
  return (
    <>
      <span className={`min-w-0 truncate ${className}`}>{you ? "you" : firstName(name)}</span>
      {guest && <GuestTag className={tagClassName} />}
    </>
  );
}
