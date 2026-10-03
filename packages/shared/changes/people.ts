// One person, one key, wherever the Changes page counts or filters people:
// the server's edition stats, the person chips, the avatars and the header.
// A commit names its author by name and email, and one person commits under
// several emails, so the name decides; an author with no name falls back to
// the email. Case, surrounding space and an agent's "(agent)" or "[bot]"
// suffix never split a person in two.

/** An agent or bot committing as someone: "Ashot (agent)", "codecast[bot]". */
const AGENT_SUFFIX = /\s*(?:\(agent\)|\[bot\])\s*$/i;

/** A commit author's name as the person it is: trimmed, with an agent or bot suffix dropped. */
export function bareName(name: string | null | undefined): string {
  return (name ?? "").trim().replace(AGENT_SUFFIX, "").trim();
}

/** The identity a person is counted and filtered by: the lowercased bareName, else the email. */
export function personKey(name: string | null | undefined, email?: string | null): string {
  return (bareName(name) || (email ?? "").trim()).toLowerCase();
}
