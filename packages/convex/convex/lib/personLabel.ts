// How a person reads on a call surface, in two audiences.
//
// A TEAMMATE sees a teammate the way the rest of the product shows them:
// their name, else the address they signed up with. Somebody OUTSIDE the
// team (a guest holding a link, which anybody it was forwarded to may hold)
// sees a name the person chose to show, and never an address: an email on a
// page anybody can open is a gift to whoever harvests them. A leaf module, so
// any function module can use it without pulling another's graph.

type PersonRow = {
  name?: string | null;
  email?: string | null;
  github_username?: string | null;
  image?: string | null;
  github_avatar_url?: string | null;
} | null | undefined;

/** A teammate as other teammates see them. */
export function teammateLabel(u: PersonRow): string {
  return u?.name?.trim() || u?.email || "A teammate";
}

/** A teammate as somebody outside the team sees them: a chosen name only. */
export function publicPersonLabel(u: PersonRow): string {
  return u?.name?.trim() || u?.github_username || "A teammate";
}

/** Their picture, from whichever source they have one. */
export function personImage(u: PersonRow): string | null {
  return u?.image ?? u?.github_avatar_url ?? null;
}
