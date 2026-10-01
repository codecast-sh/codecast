import { isGuestIdentity } from "@codecast/shared/contracts";
import { firstName } from "./speakers";

// The mark a guest wears wherever the room shows people: a face, a tile's
// name chip, a door knock, a line in the thread. A guest is somebody from
// outside the team who came in on a link, and nothing about their name says
// so (it is whatever they typed), so every surface that names a participant
// asks the identity first and marks them here, in one look.
//
// Store free on purpose: the guest's own page (app/meet) draws the same
// stage with the same marks and never loads the app's store.

/** Is this speaker or participant a guest? By identity when there is one
 *  (`guest:<id>`); a transcript line also carries the room's own marking in
 *  its name ("Ada (guest)", callSpeakerName), which a stored line keeps even
 *  where no identity rides along. */
export function isGuestParticipant(identity: string | null | undefined, name?: string | null): boolean {
  return isGuestIdentity(identity) || /\(\s*guest\s*\)\s*$/i.test(name ?? "");
}

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
  const guest = !you && isGuestParticipant(identity, name);
  return (
    <>
      <span className={`min-w-0 truncate ${className}`}>{you ? "you" : firstName(name)}</span>
      {guest && <GuestTag className={tagClassName} />}
    </>
  );
}
