// A call as the connected app's history reader tells it (Union's `history.item` on a call id): its head line
// ("Call Outbound — 2026-10-09 14:02 (2 min, connected, status ended)"), who was on it, the summary its app wrote,
// and the transcript line by line. A finding's reader shows this when the app's own call screen cannot be framed,
// so the call itself is read in place rather than named by an id. Pure.
import { appAnswerText } from "./historyLookup";

/** The reader that opens one item of a person's history by id, and its argument. */
export const CALL_READER = { name: "history.item", arg: "item" } as const;

export type CallLine = { at: string; who: "contact" | "caller"; text: string; marked: boolean };
export type CallRecord = { head: string | null; contact: string | null; caller: string | null; summary: string | null; lines: CallLine[] };

const LINE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\s+(USER|AGENT)\]\s?(.*)$/;
const HEAD = /^##\s+(Call\b.*)$/m;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Quoted words in a finding ('...' or "..." or curly quotes), long enough to find in a transcript. */
export function quotesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s(:])['"‘“]([^'"’”]{12,}?)['"’”](?=[\s.,;:)!?]|$)/g)) out.push(m[1].trim());
  return out;
}

/** The name the summary's Names list gives the person playing `role` ("- Carmit Solash — CEO ...; the contact."). */
function nameFor(summary: string, role: "contact" | "caller"): string | null {
  for (const l of summary.split("\n")) {
    const m = /^\s*-\s+([^—–-][^—–]*?)\s+[—–-]\s+(.*)$/.exec(l);
    if (m && new RegExp(`\\bthe ${role}\\b(?!'s)`, "i").test(m[2])) return m[1].trim();
  }
  return null;
}

/** The reader's text as a call; null when it is not one (no transcript and no call head). `marks` are a finding's
 *  quotes: a transcript line that holds one (or is held by one) is marked, the words the finding is about. */
export function readCallRecord(text: string | null | undefined, marks: string[] = []): CallRecord | null {
  const t = appAnswerText(text).replace(/\r\n/g, "\n");
  const head = HEAD.exec(t)?.[1]?.trim() ?? null;
  const tAt = t.search(/^Transcript\b.*:\s*$/m);
  const sAt = t.search(/^Summary:\s*$/m);
  const summary = sAt >= 0 ? t.slice(t.indexOf("\n", sAt) + 1, tAt > sAt ? tAt : undefined).trim() || null : null;
  const wanted = marks.map(norm).filter((m) => m.length >= 12);
  const lines: CallLine[] = [];
  for (const raw of (tAt >= 0 ? t.slice(tAt) : "").split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const n = norm(m[3]);
    const marked = n.length >= 8 && wanted.some((q) => q.includes(n) || n.includes(q.slice(0, 24)));
    lines.push({ at: m[1], who: m[2] === "USER" ? "contact" : "caller", text: m[3], marked });
  }
  if (!head && !lines.length) return null;
  return { head, contact: summary ? nameFor(summary, "contact") : null, caller: summary ? nameFor(summary, "caller") : null, summary, lines };
}
