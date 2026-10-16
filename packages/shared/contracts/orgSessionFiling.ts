// The person's sessions filed where they belong (org-staffing.md S43): the
// change a Head of People proposes to tidy an inbox, and where it may send a
// session. A leaf: orgProposal.ts carries the change in its union and reads
// these, so nothing here imports it.

/** The kinds that tidy the person's inbox: one ask holds them, and a role with its switch on files them itself. */
export const ORG_SESSION_KINDS: readonly string[] = ["file_session"];

/** Where a loose session of the person's goes (org-staffing.md S43): under a
 *  role ("@handle"), onto a task ("ct-N", the session joins its work), or out
 *  of the inbox as finished ("done"). `session` is its short id and `title` its
 *  title as the author read it, so the row reads cold. */
export type OrgFileSessionChange = { kind: "file_session"; session: string; to: string; title?: string };
export type OrgSessionDestination = { kind: "role"; handle: string } | { kind: "task"; task: string } | { kind: "done" };
/** What a filing's `to` names, or null when it names nothing a session can go to. */
export function sessionDestination(to: string): OrgSessionDestination | null {
  const t = (to ?? "").trim();
  if (t.toLowerCase() === "done") return { kind: "done" };
  if (/^@[a-z0-9-]{2,32}$/i.test(t)) return { kind: "role", handle: t.slice(1).toLowerCase() };
  if (/^ct-\d+$/i.test(t)) return { kind: "task", task: t.toLowerCase() };
  return null;
}

/** The filing's shape as the Head of People's reference and `cast org loose` print it. */
export const FILE_SESSION_SHAPE = 'file_session: { session: its short id, title: its title, to: "@handle" | "ct-N" | "done" }: one of the person\'s sessions moved out of their inbox: under a role, onto a task it works, or closed as done';
/** One filing as a spec's `changes` entry, exactly as `cast org propose` takes it. */
export const FILE_SESSION_EXAMPLE = '{ "change": { "kind": "file_session", "session": "jx7abcd", "title": "Its title", "to": "@growth" }, "rationale": "why it belongs there" }';
