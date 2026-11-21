// A chat line names a session one of two ways, and only one asks it to reply.
// `@jx7abcd` is an ADDRESS: the server resolves it (resolveChatMentions) and
// wakes the session. `@[Title jx7abcd]` and a bare `jx7abcd` are REFERENCES:
// they render as the same pill and wake nothing. The composer's reply strip
// reads a draft through these helpers and flips a session between the forms,
// so the text stays the one record of who is asked.

const ID = "jx[a-z0-9]{5}";
const TAIL = "(?![A-Za-z0-9_-])";
// The server's MENTION_RE boundary (shared/chat/handles.ts), narrowed to the
// one handle shape that resolves to a session (SESSION_SHORT_ID_RE).
const addressRe = () => new RegExp(`(?<![\\w/])@(${ID})${TAIL}`, "gi");
const namedRe = () => new RegExp(`@\\[([^\\]]*?)\\s+(${ID})\\]`, "gi");
const bareRe = () => new RegExp(`(?<![\\w@/-])(${ID})${TAIL}`, "gi");

type Hit = { id: string; start: number; end: number; asks: boolean };

function hits(text: string): Hit[] {
  const out: Hit[] = [];
  const named: Array<[number, number]> = [];
  for (const m of text.matchAll(namedRe())) {
    named.push([m.index!, m.index! + m[0].length]);
    out.push({ id: m[2].toLowerCase(), start: m.index!, end: m.index! + m[0].length, asks: false });
  }
  const inNamed = (i: number) => named.some(([s, e]) => i >= s && i < e);
  for (const m of text.matchAll(addressRe())) {
    if (inNamed(m.index!)) continue;
    out.push({ id: m[1].toLowerCase(), start: m.index!, end: m.index! + m[0].length, asks: true });
  }
  for (const m of text.matchAll(bareRe())) {
    if (inNamed(m.index!)) continue;
    out.push({ id: m[1].toLowerCase(), start: m.index!, end: m.index! + m[0].length, asks: false });
  }
  return out.sort((a, b) => a.start - b.start);
}

export type DraftSession = { id: string; asks: boolean };

/** The sessions a draft names, in order of first mention; `asks` when any
 *  mention of it is an address. */
export function draftSessions(text: string): DraftSession[] {
  if (!/jx/i.test(text)) return [];
  const byId = new Map<string, DraftSession>();
  for (const h of hits(text)) {
    const seen = byId.get(h.id);
    if (seen) seen.asks ||= h.asks;
    else byId.set(h.id, { id: h.id, asks: h.asks });
  }
  return [...byId.values()];
}

/** A compact, stable key for `draftSessions`: equal drafts give equal keys,
 *  so a strip keyed on it re-renders only when who is named changes. */
export function draftSessionsKey(text: string): string {
  return draftSessions(text).map((s) => `${s.id}${s.asks ? "!" : ""}`).join(" ");
}

export function parseDraftSessionsKey(key: string): DraftSession[] {
  return key ? key.split(" ").map((t) => ({ id: t.replace(/!$/, ""), asks: t.endsWith("!") })) : [];
}

/** The reference form of a session, as the picker writes it. */
export function sessionReference(id: string, title?: string | null): string {
  const clean = (title ?? "").replace(/[[\]\n]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return id;
  return `@[${clean.length > 30 ? `${clean.slice(0, 30)}...` : clean} ${id}]`;
}

/** Turn asking `id` to reply on or off. On: its first reference becomes an
 *  address. Off: every address of it becomes a reference. */
export function setSessionAsk(text: string, id: string, ask: boolean, title?: string | null): string {
  const lower = id.toLowerCase();
  const mine = hits(text).filter((h) => h.id === lower);
  const targets = ask ? mine.filter((h) => !h.asks).slice(0, 1) : mine.filter((h) => h.asks);
  if (ask && mine.some((h) => h.asks)) return text;
  let out = text;
  for (const h of [...targets].reverse()) {
    out = out.slice(0, h.start) + (ask ? `@${lower}` : sessionReference(lower, title)) + out.slice(h.end);
  }
  return out;
}
