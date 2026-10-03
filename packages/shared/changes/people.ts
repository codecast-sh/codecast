// One person, one key, wherever the Changes page counts or filters people:
// the server's edition stats, the person chips, the avatars and the header.
// A commit names its author by name and email, and one person commits under
// several emails, so the name decides; an author with no name falls back to
// the email. Case and surrounding space never split a person in two.

/** The identity a person is counted and filtered by: the trimmed, lowercased name, else the email. */
export function personKey(name: string | null | undefined, email?: string | null): string {
  return ((name ?? "").trim() || (email ?? "").trim()).toLowerCase();
}
