// The mention-handle vocabulary — the ONE definition of which "@word"s address
// which people. The server resolves mentions with these rules (convex/chatText
// re-exports this module), and both clients build their completion strips from
// the same functions, so a handle a composer offers is always a handle a send
// will resolve. Two implementations of this is how completion starts inserting
// mentions that silently fail to notify.

/** How many distinct mentions one message may carry. */
export const MAX_MENTIONS = 20;

// Boundary-aware: "@" glued to a word or a path segment is not a mention.
const MENTION_RE = /(?:^|[^\w/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})/g;

export function extractMentionHandles(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const handle = match[1].toLowerCase();
    if (handle === "here" || handle === "channel" || handle === "everyone") continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

export function mentionsHere(content: string): boolean {
  return /(?:^|[^\w/])@here\b/i.test(content);
}

// Bots are addressed by their display name (an anchor's name is set by a team
// admin, so it is not a handle an ordinary member can squat). Humans are never
// matched on their display name — that IS user-editable, and matching it would
// let anyone rename themselves to intercept a teammate's mentions.
export function botHandle(name: string | undefined): string | null {
  if (!name) return null;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return slug.length > 0 ? slug : null;
}

export function emailLocalHandle(email: string | undefined): string | null {
  const local = email?.split("@")[0]?.toLowerCase();
  return local && /^[a-z0-9_-]+$/.test(local) ? local : null;
}

/** The handle a roster member answers to, by the same priority the server
 *  resolves them: github username for humans, email local part as the fallback,
 *  display-name slug for bots. Null for a member no handle can reach. */
export function memberHandle(member: {
  github_username?: string | null;
  email?: string | null;
  name?: string | null;
  is_bot?: boolean;
}): string | null {
  if (member.is_bot) return botHandle(member.name ?? undefined);
  return member.github_username?.toLowerCase() || emailLocalHandle(member.email ?? undefined);
}
