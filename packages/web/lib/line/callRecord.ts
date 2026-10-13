// A call as the connected app's history reader tells it (Union's `history.item` on a call id): its head line
// ("Call Outbound — 2026-10-09 14:02 (2 min, connected, status ended)"), who was on it, the summary its app wrote,
// and the transcript line by line. A finding's reader shows this when the app's own call screen cannot be framed,
// so the call itself is read in place rather than named by an id. Pure.
import { appAnswerText } from "./historyLookup";

/** The reader that opens one item of a person's history by id, and its argument. */
export const CALL_READER = { name: "history.item", arg: "item" } as const;

export type CallLine = { at: string; who: "contact" | "caller"; text: string; marked: boolean };
/** Seconds from call start of a transcript time ("10:52", "1:02:05"). */
const secondsOf = (at: string) => at.split(":").reduce((n, p) => n * 60 + Number(p), 0);
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

/** Call times a finding cites ("[10:52]", "[10:52–11:07]" cites its start), as transcript times. */
export function citedTimes(text: string): string[] {
  return [...text.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[–-]\s*\d{1,2}:\d{2}(?::\d{2})?)?\]/g)].map((m) => m[1]);
}

/** The name the summary's Names list gives the person playing `role` ("- Carmit Solash — CEO ...; the contact."): the
 *  role is a clause of its own, never a mention inside another person's line ("Riley — who spoke with Caio earlier
 *  (the caller says May 18)" names Riley, not the caller). */
function nameFor(summary: string, role: "contact" | "caller"): string | null {
  for (const l of summary.split("\n")) {
    const m = /^\s*-\s+([^—–-][^—–]*?)\s+[—–-]\s+(.*)$/.exec(l);
    if (m && new RegExp(`(?:^|[;,]\\s*)the ${role}\\b(?!'s)`, "i").test(m[2])) return m[1].trim();
  }
  return null;
}

/** The reader's text as a call; null when it is not one (no transcript and no call head). `marks` are a finding's
 *  quotes: a transcript line that holds one (or is held by one) is marked, the words the finding is about. `times` are
 *  the call times it cites (citedTimes): the first line said at or within 10s after each is marked too. */
export function readCallRecord(text: string | null | undefined, marks: string[] = [], times: string[] = []): CallRecord | null {
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
  for (const t of new Set(times.map(secondsOf))) {
    const hit = lines.find((l) => { const at = secondsOf(l.at); return at >= t && at <= t + 10; });
    if (hit) hit.marked = true;
  }
  if (!head && !lines.length) return null;
  return { head, contact: summary ? nameFor(summary, "contact") : null, caller: summary ? nameFor(summary, "caller") : null, summary, lines };
}

const HEAD_PARTS = /^Call\s+(Outbound|Inbound)?\s*[—–-]\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}:\d{2})\s*(?:\(([^,)]+))?/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The call as its head names it: who called whom, the day and time as the app wrote them, how long it ran. */
export function callHead(c: Pick<CallRecord, "head" | "contact" | "caller">): { who: string; when: string | null; length: string | null } {
  const m = c.head ? HEAD_PARTS.exec(c.head) : null;
  const inbound = m?.[1]?.toLowerCase() === "inbound";
  // A call whose record names only one side says who it was with, never "The caller called ...".
  const who = c.caller && c.contact ? (inbound ? `${c.contact} called ${c.caller}` : `${c.caller} called ${c.contact}`)
    : c.contact ? `Call with ${c.contact}` : c.caller ? `Call with ${c.caller}` : "Call";
  const when = m ? `${MONTHS[Number(m[3]) - 1] ?? m[3]} ${Number(m[4])}, ${m[5]}` : null;
  return { who, when, length: m?.[6]?.trim() || null };
}

/** The lines a call opens on: `around` lines either side of each marked line, as runs of transcript indexes (a gap
 *  between runs is lines left out). Empty when nothing is marked: the call then opens whole. */
export function callExcerpt(lines: ReadonlyArray<Pick<CallLine, "marked">>, around = 3): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  lines.forEach((l, i) => {
    if (!l.marked) return;
    const from = Math.max(0, i - around), to = Math.min(lines.length - 1, i + around);
    const last = out[out.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  });
  return out;
}
