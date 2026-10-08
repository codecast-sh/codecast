"use client";
// Who a person is in the company, one hover away from every place their face
// shows (cohesive build spec §5.5, D14): the same facts their sheet's head
// says (their place, presence, what they answer for, since when), the goals
// they own, and what carries them. Paints from the store (the org tree and
// the roster); a person the store does not know yet keeps the face and the
// name the caller already had. A click opens their sheet.
import { personRefOf } from "@codecast/shared/entities";
import { SummaryFrame } from "../org/lines/ObjectSummary";
import { usePersonHead } from "../org/lines/useHeads";
import { HoverCard } from "../ui/HoverCard";
import { AssigneeFace } from "./AssigneeFace";
import { ObjectCardBody } from "./objectCard";

/** Whom the card is about: their user id or handle, and what the caller already shows. */
export type PersonRef = { userId?: string | null; handle?: string | null; name?: string; image?: string };

export function PersonHoverContent({ person, onOpen }: { person: PersonRef; onOpen?: (e: React.MouseEvent) => void }) {
  const ref = person.userId || person.handle || null;
  const head = usePersonHead(ref);
  const name = head?.name ?? person.name ?? person.handle ?? "Someone";
  const image = head?.image ?? person.image;
  const refId = head?.line.ref ?? (person.handle || (person.userId ? personRefOf({ _id: person.userId }) : null));
  // The foot names them by handle; someone without one keeps their id in the address only.
  const handle = head ? head.handle : person.handle || null;
  const glyph = <AssigneeFace info={{ name, image }} size={18} hover={false} />;
  const summary = head
    ? <SummaryFrame kind="person" glyph={glyph} title={head.line.me ? `${name} (you)` : name} facts={head.facts} serves={head.serves} carried={head.carried} />
    : <SummaryFrame kind="person" glyph={glyph} title={name} facts={{ owner: null, state: null, measure: null, date: null }} serves={[]} carried={null} />;
  if (!refId) return <div className="p-3 text-xs" data-person-card="">{summary}</div>;
  return (
    <ObjectCardBody kind="person" refId={refId} label="Open" foot={handle ? `@${handle}` : null} onOpen={onOpen} data-person-card={refId}>
      {summary}
    </ObjectCardBody>
  );
}

/** Wraps anything that names a person (their face, their name); the card opens on hover. */
export function PersonHoverCard({ person, children, side, align, disabled, triggerClassName }: { person: PersonRef; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; disabled?: boolean; triggerClassName?: string }) {
  return (
    <HoverCard card={<PersonHoverContent person={person} />} side={side} align={align} disabled={disabled || !(person.userId || person.handle)} className="w-[22rem]" triggerClassName={triggerClassName}>
      {children}
    </HoverCard>
  );
}
