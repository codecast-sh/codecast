// How `cast own`, `cast disown` and `cast owners` name a session's owners,
// read from sessionOwnership.listOwners: people, at most one role, the
// session that started it, and the person who started it while nothing else
// owns it. Its own module so the wording is unit-testable (index.ts runs the
// CLI on import).

type Person = { name?: string | null; email?: string | null };

export type OwnersRead = {
  short_id?: string;
  owners?: Person[];
  session_owners?: boolean;
  people?: Person[];
  role?: { handle: string; name?: string | null } | null;
  parent_session?: { short_id: string; title?: string | null } | null;
  implicit_starter?: Person | null;
  can_edit?: boolean;
};

const nameOf = (p: Person | null | undefined) => p?.name || p?.email || "?";

/** One line: the people, then the role, then the parent session. */
export function ownersLine(read: OwnersRead): string {
  if (!read.session_owners) return read.owners?.length ? read.owners.map(nameOf).join(", ") : "nobody";
  const parts = [
    ...(read.people ?? []).map(nameOf),
    ...(read.implicit_starter ? [nameOf(read.implicit_starter)] : []),
    ...(read.role ? [`@${read.role.handle}`] : []),
    ...(read.parent_session ? [`session ${read.parent_session.short_id}`] : []),
  ];
  return parts.length ? parts.join(", ") : "nobody";
}

/** `cast owners`: each kind of owner on its line, the agent that answers it,
 *  and what the viewer may change. */
export function ownersView(read: OwnersRead): string[] {
  if (!read.session_owners) return [`owners: ${ownersLine(read)}`];
  const lines: string[] = [];
  const people = (read.people ?? []).map(nameOf);
  if (people.length) lines.push(`people:  ${people.join(", ")}`);
  if (read.implicit_starter) lines.push(`people:  ${nameOf(read.implicit_starter)} (started it; owns it while nothing else does)`);
  if (read.role) lines.push(`role:    @${read.role.handle}${read.role.name ? ` (${read.role.name})` : ""}, answers it`);
  if (read.parent_session) {
    const title = read.parent_session.title ? ` ${read.parent_session.title}` : "";
    lines.push(`session: ${read.parent_session.short_id}${title}${read.role ? "" : ", answers it"}`);
  }
  if (!lines.length) lines.push("nobody owns it");
  lines.push(read.can_edit ? "you can change its owners" : "you can add yourself: cast own <session>");
  return lines;
}

