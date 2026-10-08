"use client";
// A role as one line (cohesive build spec §6): who it answers to, what its
// standing agent says it is doing (its own declared word, else what its
// sessions are doing), what it leads or drives, and since when it is here. A
// role does not open in place: everything more is its sheet.
import { RoleFace } from "../RoleFace";
import { roleFacts, type LineRole } from "./lineFacts";
import { ObjectLine, type LineGhost, type ObjectLineProps } from "./ObjectLine";

export { RoleState } from "./lineAtoms";
export type { LineRole } from "./lineFacts";

export type RoleLineProps = { line: LineRole; now: number; ghost?: LineGhost } & Pick<ObjectLineProps, "depth" | "sub" | "selected">;

export function RoleLine({ line, now, ghost, ...rest }: RoleLineProps) {
  const { role } = line;
  return (
    <ObjectLine
      kind="role"
      id={role._id}
      target={ghost ? undefined : { kind: "role", ref: role.short_id }}
      glyph={<RoleFace role={role} size={18} />}
      title={role.name}
      {...roleFacts(line, now)}
      ghost={ghost}
      data-line-ref={role.short_id}
      {...rest}
    />
  );
}
