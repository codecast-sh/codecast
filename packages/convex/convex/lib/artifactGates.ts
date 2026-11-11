// The viewing gates on a published page, in one place.
//
// Two transports reach the same rows: the HTTP serve/comment routes and the
// public Convex mutations, which are internet-callable in their own right.
// When each transport carried its own copy of the gate, they disagreed — the
// serve route refused an expired or password-protected page while
// `artifacts.submitComments` accepted an anonymous comment on it. So the
// checks live here and both callers run the same ones.
//
// The tokens are deterministic digests rather than stored secrets: the URL
// stays a stable cache key, and changing the password rotates every `?k=`
// link that was ever handed out.
//
// A team gate (team_gate) is the one gate that is access control rather than a
// shared secret: the page belongs to a team whose policy marks its data as
// regulated, and only that team's signed-in members are handed its `m` token
// (artifacts.ownerUnlock / embedInfo), each their own, checked against their
// current membership whenever it is presented. It is checked before the others, so a
// password or email wall on top of it never opens it to anyone else.
import { sha256Hex } from "./hash";

export type GatedArtifact = {
  slug: string;
  password_hash?: string | null;
  email_gate?: boolean;
  owner_key?: string | null;
  expires_at?: number | null;
  team_gate?: string | null;
};

export { sha256Hex };

export async function passwordHash(password: string, slug: string): Promise<string> {
  return await sha256Hex(`${password}:${slug}`);
}

/** Deterministic unlock token — knowing it ≈ knowing the password, and it
 * rotates when the password changes. Deterministic so the ?k= URL stays a
 * stable cache key. */
export async function kTokenFor(password_hash: string, slug: string): Promise<string> {
  return (await sha256Hex(`${password_hash}:${slug}`)).slice(0, 24);
}

export async function eTokenFor(owner_key: string, slug: string): Promise<string> {
  return (await sha256Hex(`${owner_key}:emailgate:${slug}`)).slice(0, 24);
}

/** A member's token for a team-gated page: `<user id>.<digest>`. The digest
 * is keyed on owner_key (a secret the page holds), so nobody can mint one for
 * a page or a user; the user id in it is who the token was handed to, and the
 * gate re-checks that person's CURRENT membership on every use
 * (artifacts.teamGateAdmits). So a removed member's token, and any link they
 * forwarded, stops opening the page the moment they leave. A page without an
 * owner_key has no member token, and its gate stays shut. */
export async function mTokenFor(
  a: { slug: string; owner_key?: string | null; team_gate?: string | null },
  userId: string,
): Promise<string | null> {
  if (!a.team_gate || !a.owner_key) return null;
  return `${userId}.${(await sha256Hex(`${a.owner_key}:team:${a.team_gate}:${a.slug}:${userId}`)).slice(0, 24)}`;
}

/** Who a presented member token was handed to, or null when it is not a
 * genuine token for this page. Says nothing about whether they may still
 * open it: that is a membership read the caller makes. */
export async function mTokenHolder(
  a: { slug: string; owner_key?: string | null; team_gate?: string | null },
  m: string | null | undefined,
): Promise<string | null> {
  const dot = m ? m.indexOf(".") : -1;
  if (!m || dot <= 0) return null;
  const userId = m.slice(0, dot);
  const expected = await mTokenFor(a, userId);
  return expected !== null && expected === m ? userId : null;
}

/** The words a team-gated page shows anyone without its member token. */
export function teamGateMessage(teamName: string | null | undefined): string {
  return `This page holds ${teamName ?? "a team"}'s regulated data and opens only for its signed-in members`;
}

/** True when the artifact's own state makes it unreadable without a token.
 * The email wall counts: it is a capture step, not secrecy, but it still
 * stands between an anonymous visitor and the page. */
export function isGated(a: GatedArtifact, now = Date.now()): boolean {
  return !!a.team_gate || !!a.password_hash || !!a.email_gate || (!!a.expires_at && now > a.expires_at);
}

export function isExpired(a: GatedArtifact, now = Date.now()): boolean {
  return !!a.expires_at && now > a.expires_at;
}

/** Null when the caller may act on the page, else the reason it cannot.
 * Order matches the serve route: expiry, team, password, then email wall. */
export async function gateFailure(
  a: GatedArtifact,
  presented: { k?: string; e?: string; m?: string; now?: number },
  // Whether the member token's holder may open the page today (owner, or a
  // current member of the gate team). Required for a team-gated page: without
  // it the gate stays shut.
  admits?: (holder: string) => Promise<boolean>,
): Promise<string | null> {
  const now = presented.now ?? Date.now();
  if (isExpired(a, now)) return "This page has expired";
  if (a.team_gate) {
    const holder = await mTokenHolder(a, presented.m);
    if (!holder || !admits || !(await admits(holder))) return teamGateMessage(null);
  }
  if (a.password_hash && presented.k !== (await kTokenFor(a.password_hash, a.slug))) {
    return "This page is password protected";
  }
  if (a.email_gate && a.owner_key && presented.e !== (await eTokenFor(a.owner_key, a.slug))) {
    return "This page asks viewers for their email first";
  }
  return null;
}
