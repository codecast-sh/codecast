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

export type GatedArtifact = {
  slug: string;
  password_hash?: string | null;
  email_gate?: boolean;
  owner_key?: string | null;
  expires_at?: number | null;
};

export async function sha256Hex(s: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

/** True when the artifact's own state makes it unreadable without a token.
 * The email wall counts: it is a capture step, not secrecy, but it still
 * stands between an anonymous visitor and the page. */
export function isGated(a: GatedArtifact, now = Date.now()): boolean {
  return !!a.password_hash || !!a.email_gate || (!!a.expires_at && now > a.expires_at);
}

export function isExpired(a: GatedArtifact, now = Date.now()): boolean {
  return !!a.expires_at && now > a.expires_at;
}

/** Null when the caller may act on the page, else the reason it cannot.
 * Order matches the serve route: expiry, then password, then email wall. */
export async function gateFailure(
  a: GatedArtifact,
  presented: { k?: string; e?: string; now?: number },
): Promise<string | null> {
  const now = presented.now ?? Date.now();
  if (isExpired(a, now)) return "This page has expired";
  if (a.password_hash && presented.k !== (await kTokenFor(a.password_hash, a.slug))) {
    return "This page is password protected";
  }
  if (a.email_gate && a.owner_key && presented.e !== (await eTokenFor(a.owner_key, a.slug))) {
    return "This page asks viewers for their email first";
  }
  return null;
}
