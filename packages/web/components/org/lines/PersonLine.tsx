"use client";
// A person as one line (cohesive build spec §6): their place in the
// workspace, whether they are here now, what they answer for and how many
// sessions they run, and since when. The roles they host or that report to
// them follow as their own lines; opened in place, the line names the goals
// they own.
import { AssigneeFace } from "../../identity/AssigneeFace";
import { personFacts, type LinePerson } from "./lineFacts";
import { ObjectLine, type ObjectLineProps } from "./ObjectLine";

export { PersonPresence } from "./lineAtoms";
export type { LinePerson } from "./lineFacts";

export type PersonLineProps = {
  person: LinePerson;
  now: number;
  /** Their roles are drawn as lines right under this one: the line does not count them. */
  rolesShown?: boolean;
} & Pick<ObjectLineProps, "depth" | "expanded" | "onToggle" | "selected">;

export function PersonLine({ person, now, rolesShown, ...rest }: PersonLineProps) {
  return (
    <ObjectLine
      kind="person"
      id={person.id}
      target={{ kind: "person", ref: person.ref }}
      glyph={<AssigneeFace info={{ name: person.name, image: person.image }} size={18} personId={person.id} />}
      title={person.name}
      sub={person.me ? "you" : undefined}
      {...personFacts(person, now, { rolesShown })}
      data-line-ref={person.ref}
      {...rest}
    />
  );
}
