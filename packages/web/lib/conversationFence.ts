// The `conversation` fenced block: a thread with someone, then the reply an
// agent sent before a change beside the reply it sends with it. A review card
// for a change to what an agent writes shows people's own words this way, so
// the person deciding reads the replies in place instead of counts of them.
// Pure: components/ConversationFence draws it.

export const CONVERSATION_FENCE_LANG = "conversation";

export type ConversationMessage = { from: string; text: string; at: string | null; agent: boolean };
export type ConversationFenceSpec = {
  title: string | null;
  thread: ConversationMessage[];
  before: string;
  after: string;
  /** Phrases to mark in each reply: the words that show the difference. */
  mark: { before: string[]; after: string[] };
  note: string;
};
export type ConversationFenceRead = { ok: true; spec: ConversationFenceSpec } | { ok: false; why: string };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** A message as its reader saw it: emphasis markers dropped and links read as their words, as a mail client draws them. */
const plain = (v: unknown): string =>
  str(v)
    .replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(plain).filter(Boolean) : plain(v) ? [plain(v)] : []);

/**
 * A fence's body as a spec:
 * `{"agent":"Union","thread":[{"from","text","at"?}],"before","after","mark"?:{"before":[],"after":[]},"note"?,"title"?}`.
 * Messages from `agent` sit on the agent's side; a reply side may be empty.
 */
export function readConversationFence(code: string): ConversationFenceRead {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return { ok: false, why: "The block is not JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "The block is not an object." };
  const o = raw as Record<string, unknown>;
  const agent = str(o.agent);
  const thread = (Array.isArray(o.thread) ? o.thread : [])
    .map((m): ConversationMessage | null => {
      if (!m || typeof m !== "object") return null;
      const r = m as Record<string, unknown>;
      const from = str(r.from);
      const text = plain(r.text);
      return text ? { from, text, at: str(r.at) || null, agent: !!agent && from === agent } : null;
    })
    .filter((m): m is ConversationMessage => m !== null);
  const before = plain(o.before);
  const after = plain(o.after);
  if (!before && !after) return { ok: false, why: "The block has neither a before nor an after reply." };
  const mark = (o.mark && typeof o.mark === "object" ? o.mark : {}) as Record<string, unknown>;
  return {
    ok: true,
    spec: { title: str(o.title) || null, thread, before, after, mark: { before: strs(mark.before), after: strs(mark.after) }, note: str(o.note) },
  };
}

/** `text` cut at each occurrence of a phrase, with `marked` set on the phrase. Matching ignores case and runs of whitespace. */
export function markPhrases(text: string, phrases: string[]): Array<{ text: string; marked: boolean }> {
  const spans: Array<[number, number]> = [];
  for (const p of phrases) {
    const pattern = new RegExp(p.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi");
    for (const m of text.matchAll(pattern)) spans.push([m.index!, m.index! + m[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const [s, e] of spans) {
    if (s < at) continue;
    if (s > at) out.push({ text: text.slice(at, s), marked: false });
    out.push({ text: text.slice(s, e), marked: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false });
  return out;
}

export const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// A reply split into its sentences and list items, separators kept, so the
// text renders as written and a changed piece can be marked.
const PIECE = /((?<=[.!?])\s+(?=\S)|\s+-\s+|\n+)/;

const wordsOf = (t: string) => new Set(squash(t).split(" ").filter(Boolean));
/** Two pieces say the same thing when most of their words are shared ("Add the button" and "Added the button"). */
const samePiece = (a: Set<string>, b: Set<string>) => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared) >= 0.5;
};

/** The pieces of `text` with `changed` set on each one `other` does not say.
 *  Nothing is marked when most pieces changed: a reply marked nearly whole
 *  says nothing a reader cannot see. */
export function changedPieces(text: string, other: string): Array<{ text: string; changed: boolean }> {
  const parts = text.split(PIECE);
  const theirs = other.split(PIECE).filter((_, i) => i % 2 === 0).map(wordsOf).filter((w) => w.size > 0);
  const out = parts.map((t, i) => {
    const mine = i % 2 === 0 ? wordsOf(t) : null;
    return { text: t, changed: !!mine && mine.size > 0 && !theirs.some((w) => samePiece(mine, w)) };
  });
  const pieces = out.filter((p, i) => i % 2 === 0 && squash(p.text));
  const changed = pieces.filter((p) => p.changed).length;
  return changed > 0 && changed <= pieces.length / 2 ? out : out.map((p) => ({ ...p, changed: false }));
}

/** A reply's pieces with `changed` set on what matters: the phrases its author named, else what `other` does not say. */
export function replyPieces(text: string, other: string, marks: string[]): Array<{ text: string; changed: boolean }> {
  return marks.length ? markPhrases(text, marks).map((p) => ({ text: p.text, changed: p.marked })) : changedPieces(text, other);
}
