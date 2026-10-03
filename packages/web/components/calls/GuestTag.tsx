import { callParticipantKind } from "@codecast/shared/contracts";
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

/** The mark an agent's face wears (an `agent:` identity from the face
 *  worker): a face and a name that can pass for a person's, so it is marked
 *  with the same rigor as a guest, in the other direction. A guest has no
 *  thread or agents panel to learn otherwise from. */
export function AgentTag({ className = "", title = "An AI agent, not a person" }: { className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-[4px] bg-sol-violet/15 px-1 py-px font-mono text-[9.5px] font-medium leading-none tracking-wide text-sol-violet ring-1 ring-inset ring-sol-violet/25 ${className}`}
    >
      agent
    </span>
  );
}

/** Whichever mark this participant wears: a guest's, an agent's, or none
 *  for a teammate. The one place a surface asks, so the two marks are never
 *  decided by two different tests. */
export function ParticipantTag({ identity, name, className = "" }: { identity?: string | null; name?: string | null; className?: string }) {
  if (identity && callParticipantKind(identity) === "agent") return <AgentTag className={className} />;
  return isGuestParticipant(identity, name) ? <GuestTag className={className} /> : null;
}

/** A participant's first name, with the guest or agent mark when they are one. The one
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
  return (
    <>
      <span className={`min-w-0 truncate ${className}`}>{you ? "you" : firstName(name)}</span>
      {!you && <ParticipantTag identity={identity} name={name} className={tagClassName} />}
    </>
  );
}
