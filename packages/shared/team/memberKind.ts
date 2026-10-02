// What a roster row IS. A team's roster holds people and three kinds of
// synthetic identity, all `users` rows with `is_bot`:
//   - "slack": a Slack person (or a workspace bridge) speaking through a
//     shadow identity in mirrored channels and DMs (bot_kind "slack").
//   - "agent": a role or anchor identity (bot_kind "role" / "anchor"), or a
//     full agent account with its own login and daemon (no bot_kind).
// A surface that lists PEOPLE (a directory, charts, a picker, a count, a
// per-person setting) keeps `isPerson` rows only. Surfaces that resolve a name
// for an id, or that address bots on purpose (@mentions, the face row), read
// the whole roster.

export type MemberKind = "person" | "slack" | "agent";

type KindFacts = { is_bot?: boolean | null; bot_kind?: string | null } | null | undefined;

export function memberKind(m: KindFacts): MemberKind {
  if (!m?.is_bot) return "person";
  return m.bot_kind === "slack" ? "slack" : "agent";
}

export function isPerson<T extends KindFacts>(m: T): m is NonNullable<T> {
  return !!m && !m.is_bot;
}

/** The people in a roster, nulls dropped. */
export function peopleOf<T extends KindFacts>(members: readonly T[] | null | undefined): NonNullable<T>[] {
  return (members ?? []).filter(isPerson);
}
