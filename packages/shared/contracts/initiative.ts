// An initiative (docs/architecture/initiatives-projects-role-page.md I1): a
// goal the company is trying to reach, carried by an intentional set of
// projects, with one owner who drives it. ONE definition of its values and its
// synced row, read by the server validators (convex/initiatives.ts), the CLI
// (`cast initiative`) and the web store, so no two surfaces name a different
// status or health.
//
// The row is raw. Everything a page shows beside it is derived at render from
// the store: progress (tasks done over tasks in its projects), each project's
// lead (contracts/orgLead.ts), the owner's face and name, and sub initiatives
// (rows whose `parent_initiative_id` names this one).
//
// The intent record (I5) is the row's second half: why it matters, what done
// looks like, milestones, every reported number over time, open questions,
// decisions taken, and the sources that say who stated the goal and where.

import { matchHandle, memberHandle } from "../chat/handles";
import { parseEntityUrl } from "../entities";

export const INITIATIVE_STATUSES = ["proposed", "planned", "active", "completed", "cancelled"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** What an update may say. `none` is the row's value before any update exists. */
export const INITIATIVE_UPDATE_HEALTHS = ["on_track", "at_risk", "off_track"] as const;
export type InitiativeUpdateHealth = (typeof INITIATIVE_UPDATE_HEALTHS)[number];
export type InitiativeHealth = "none" | InitiativeUpdateHealth;
export const INITIATIVE_HEALTHS = ["none", ...INITIATIVE_UPDATE_HEALTHS] as const;

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  proposed: "Proposed",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const INITIATIVE_HEALTH_LABEL: Record<InitiativeHealth, string> = {
  none: "No update",
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

/** A person or a role: roles are colleagues (org-roles-run-work.md R5). */
export type InitiativeOwner =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string };

/** Who wrote an update: a person, or a role through its standing session. */
export type InitiativeUpdateAuthor =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string; conversation_id?: string };

export type InitiativePriority = "p0" | "p1" | "p2" | "p3";

/**
 * How a goal is measured: one or two numbers with a target each, read against
 * the target wherever the goal is read (the page, the health panel, the role
 * card and the review), so "on track" means against the target and not only
 * what the owner said. The value is reported the way a template's scoreboard
 * is (`cast initiative report in-N key=value --source`, the same
 * `recordScores` path as `cast org template report`), and lives in
 * `scoreboard` under the metric's key with its source and date.
 */
export type InitiativeMetric = {
  /** A slug (metricKeyOf(name)); the scoreboard's key. */
  key: string;
  name: string;
  /** The number to reach, as written: "1000", "$50k", "< 5%", "at least 40". */
  target: string;
};
export const INITIATIVE_METRICS_MAX = 2;
/** A reported value: the template scoreboard's own shape (orgTemplateState.ScoreState). */
export type InitiativeScore = { value: string; observed_at: number; source: string };

export const metricKeyOf = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

/**
 * Read a number out of a target or a value as people write them: "1,000",
 * "$50k", "2.5M", "38%", "at least 40", "< 5%". Null when there is none.
 */
export function metricNumber(text: string | null | undefined): number | null {
  const m = (text ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?\s*([kKmM])?(?![a-zA-Z])/);
  if (!m) return null;
  const n = Number(m[0].replace(/[kKmM\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = m[1]?.toLowerCase();
  return unit === "k" ? n * 1_000 : unit === "m" ? n * 1_000_000 : n;
}
/** The way a target is to be met: reach it (the default), or stay under it ("< 5%", "under 3", "at most 10"). */
export const metricDirection = (target: string): "at_least" | "at_most" => /^\s*(?:<=?|(?:under|below|at most|no more than|max(?:imum)?)\b)/i.test(target) || /\bor (?:less|fewer|under)\b/i.test(target) ? "at_most" : "at_least";

export type MetricStanding = "met" | "behind" | "unknown";
export type MetricReading = InitiativeMetric & {
  /** The reported value as written, or null before one was reported. */
  value: string | null;
  observed_at: number | null;
  source: string | null;
  /** Against the target: met, behind, or unknown when either side is not a number. */
  standing: MetricStanding;
  /** How far toward a reach target, 0 to 1; null when it cannot be read. */
  progress: number | null;
};

/** One metric read against its target. */
export function metricReading(metric: InitiativeMetric, score?: InitiativeScore | null): MetricReading {
  const value = score?.value ?? null;
  const n = metricNumber(value);
  const t = metricNumber(metric.target);
  const direction = metricDirection(metric.target);
  const standing: MetricStanding = n === null || t === null ? "unknown" : direction === "at_most" ? (n <= t ? "met" : "behind") : (n >= t ? "met" : "behind");
  const progress = n === null || t === null || t <= 0 || direction === "at_most" ? null : Math.max(0, Math.min(1, n / t));
  return { ...metric, value, observed_at: score?.observed_at ?? null, source: score?.source ?? null, standing, progress };
}
export const metricReadings = (row: Pick<InitiativeRow, "metrics" | "scoreboard">): MetricReading[] => (row.metrics ?? []).map((m) => metricReading(m, row.scoreboard?.[m.key]));

/** Whether a value reads "of" its target: a number to reach. A number to stay under ("under 20") and a target that is not a number are named as the target instead. */
export const metricReaches = (target: string): boolean => metricDirection(target) === "at_least" && metricNumber(target) !== null;
/** The value against its target, in the words every surface uses: "412 of 1,000", "34, target under 20", and "target 1,000" before a value is reported. */
export function metricAgainst(r: Pick<MetricReading, "value" | "target">): string {
  if (r.value === null) return `target ${r.target}`;
  return metricReaches(r.target) ? `${r.value} of ${r.target}` : `${r.value}, target ${r.target}`;
}

/** "Weekly active teams: 412 of 1,000, behind (28 Sep)" or "Weekly active teams: not reported yet, target 1,000". */
export function metricLine(r: MetricReading, now = Date.now()): string {
  if (r.value === null) return `${r.name}: not reported yet, ${metricAgainst(r)}`;
  const when = r.observed_at ? ` (${dayWord(r.observed_at, now)})` : "";
  const word = r.standing === "met" ? "met" : r.standing === "behind" ? "behind" : "";
  return `${r.name}: ${metricAgainst(r)}${word ? `, ${word}` : ""}${when}`;
}
function dayWord(at: number, now: number): string {
  // Calendar days, not elapsed 24 hour blocks: a report at noon yesterday reads "yesterday" this morning.
  const dayOf = (t: number) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  const days = Math.round((dayOf(now) - dayOf(at)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const d = new Date(at);
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
}

/** The goal's standing against its numbers as one word: behind if any metric is, met if every reported one is, else unknown. */
export function initiativeStanding(readings: MetricReading[]): MetricStanding {
  if (readings.some((r) => r.standing === "behind")) return "behind";
  if (readings.length && readings.every((r) => r.standing === "met")) return "met";
  return "unknown";
}

// ── The intent record (I5) ───────────────────────────────────────────────────

export const INTENT_SOURCE_KINDS = ["call", "chat", "doc", "session", "task", "plan", "link", "note"] as const;
export type IntentSourceKind = (typeof INTENT_SOURCE_KINDS)[number];

/**
 * Who said it and where. `ref` is the object's own address: a call reference
 * (`cl-42`, `cl-42:15`, the shared/entities form), a chat message id, a doc id, a session short id with an
 * optional `:line`, `ct-N`, `pl-N`, or a URL. `quote` is the words as said.
 * A `note` has no address: its quote is all there is.
 */
export type IntentSource = { kind: IntentSourceKind; ref?: string; quote?: string; by?: string; at?: number };

export const INTENT_SOURCE_LABEL: Record<IntentSourceKind, string> = {
  call: "Call", chat: "Chat", doc: "Doc", session: "Session", task: "Task", plan: "Plan", link: "Link", note: "Note",
};

const QUOTE_MAX = 400;
const trimQuote = (text: string): string | undefined => {
  const t = text.trim().replace(/^[\s:,;-]+/, "").replace(/^["'“‘]([\s\S]*)["'”’]$/, "$1").trim();
  return t ? t.slice(0, QUOTE_MAX) : undefined;
};

const isWebAddress = (t: string): boolean => /^https?:\/\/\S+$/i.test(t);
/** A codecast link or path read as the object it opens (a call, a doc, a session, a task, a plan), by the one url reader (shared/entities parseEntityUrl). */
function readEntityAddress(href: string): Pick<IntentSource, "kind" | "ref"> | null {
  const entity = parseEntityUrl(href);
  return entity && /^(call|doc|session|task|plan)$/.test(entity.type) ? readSourceRef(`${entity.type}:${entity.id}`) : null;
}

/** One address read as a source kind and ref, or null when it is not an address. */
function readSourceRef(token: string): Pick<IntentSource, "kind" | "ref"> | null {
  const t = token.trim().replace(/[.,;:]+$/, "");
  if (!t) return null;
  if (isWebAddress(t)) return readEntityAddress(t) ?? { kind: "link", ref: t };
  if (t.startsWith("/")) return readEntityAddress(t);
  if (/^ct-\d+$/i.test(t)) return { kind: "task", ref: t.toLowerCase() };
  if (/^pl-\d+$/i.test(t)) return { kind: "plan", ref: t.toLowerCase() };
  const named = t.match(/^(call|chat|doc|session|task|plan):(\S+)$/i);
  if (named) {
    const kind = named[1].toLowerCase() as IntentSourceKind;
    // A call line reads "call:cl-42:14" or "call:cl-42#14"; both store as the
    // shared call reference form (shared/entities callRefId), "cl-42:14".
    const ref = kind === "call" ? named[2].replace(/#(\d+(?:-\d+)?)$/, ":$1").toLowerCase() : named[2];
    return { kind, ref };
  }
  // A session short id, alone or with a line: "jx7c6zk", "jx7c6zk:142".
  if (/^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{7}(?::\d+(?:-\d+)?)?$/.test(t)) return { kind: "session", ref: t };
  return null;
}

/**
 * Read a source the way people and the review write one: an address alone
 * ("call:k57abc#14", "jx7c6zk:142", "ct-12", a URL), an address followed by
 * the words said, or plain words, which are a note. Never throws: text that
 * names no address is still a record of what was said.
 */
export function parseIntentSource(text: string, extra: Pick<IntentSource, "by" | "at" | "quote"> = {}): IntentSource {
  const t = (text ?? "").trim();
  const [first, ...rest] = t.split(/\s+/);
  const ref = readSourceRef(first ?? "");
  const quote = extra.quote?.trim() ? trimQuote(extra.quote) : trimQuote(ref ? rest.join(" ") : t);
  const out: IntentSource = ref ? { ...ref } : { kind: "note" };
  if (quote) out.quote = quote;
  if (extra.by?.trim()) out.by = extra.by.trim().slice(0, 80);
  if (extra.at) out.at = extra.at;
  return out;
}

/** Two sources are the same when they name the same address, or say the same words with none. */
export const intentSourceKey = (s: IntentSource): string => `${s.kind}:${(s.ref ?? s.quote ?? "").trim().toLowerCase()}`;

/** "Call, line 14", "Session jx7c6zk, line 142", "ct-12", "Note". The words a link wears. */
export function intentSourceLabel(s: IntentSource): string {
  const ref = s.ref ?? "";
  switch (s.kind) {
    case "call": { const m = ref.match(/^([^:@]+)(?::(\d+(?:-\d+)?))?(?:@(.+))?$/); return m?.[2] ? `Call ${m[1]}, line ${m[2]}` : m?.[3] ? `Call ${m[1]} at ${m[3]}` : `Call ${m?.[1] ?? ref}`; }
    case "session": { const [id, line] = ref.split(":"); return line ? `Session ${id}, line ${line}` : `Session ${id}`; }
    case "task": case "plan": return ref;
    case "link": { try { return new URL(ref).hostname.replace(/^www\./, ""); } catch { return "Link"; } }
    default: return INTENT_SOURCE_LABEL[s.kind];
  }
}

/** A source's address as a person writes it, the form parseIntentSource reads back: "call:cl-42:14", "ct-12", a URL. Empty for a note, which has none. */
export const intentSourceAddress = (s: IntentSource): string => s.kind === "note" ? "" : s.ref && s.kind !== "task" && s.kind !== "plan" && s.kind !== "link" ? `${s.kind}:${s.ref}` : (s.ref ?? "");

/** "Ashot on a call, 30 Sep: our goal is $250 or less per introduction" for a terminal and a prompt. */
export function intentSourceLine(s: IntentSource, now = Date.now()): string {
  const where = intentSourceAddress(s);
  const head = [s.by, where, s.at ? dayWord(s.at, now) : ""].filter(Boolean).join(", ");
  return s.quote ? (head ? `${head}: "${s.quote}"` : `"${s.quote}"`) : head || "Note";
}

/** Add sources to a list, keeping the first of any two that are the same, capped at the list's limit: each is one `add` of applyRecordOp. */
export function mergeIntentSources(prior: readonly IntentSource[] | undefined, more: readonly IntentSource[]): IntentSource[] {
  let out: IntentSource[] = [...(prior ?? [])];
  for (const entry of more) {
    const added = applyRecordOp(out, { list: "sources", action: "add", entry }, { now: 0 });
    if (!("error" in added)) out = added.next;
  }
  return out;
}

/** A step on the way, with the day it is due and the moment it was reached. */
export type InitiativeMilestone = { key: string; title: string; date?: number; done_at?: number; source?: IntentSource };
/** Something still undecided. An answer closes it; the question stays on the record. */
export type InitiativeQuestion = { key: string; text: string; at: number; by?: string; source?: IntentSource; answer?: string; answered_at?: number };
/** Something that was decided, by whom and where. */
export type InitiativeDecision = { key: string; text: string; at: number; by?: string; source?: IntentSource };

/** The record's four lists and how many entries each holds. */
export const INITIATIVE_RECORD_LISTS = ["milestones", "questions", "decisions", "sources"] as const;
export type InitiativeRecordList = (typeof INITIATIVE_RECORD_LISTS)[number];
export const INITIATIVE_RECORD_MAX: Record<InitiativeRecordList, number> = { milestones: 12, questions: 20, decisions: 40, sources: 20 };
/** How many reported values a metric keeps: a year of weekly reports. */
export const INITIATIVE_SCORE_HISTORY_MAX = 52;

/** A short key for a new entry, unique within its list: a slug of its words, numbered on a clash. */
export function recordEntryKey(text: string, taken: readonly string[]): string {
  const base = metricKeyOf(text).slice(0, 32) || "entry";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

// ── The record's one reducer (I5) ────────────────────────────────────────────
// Every edit of the four lists is one op applied by applyRecordOp: the server
// (`initiatives.record`, the create and update cores, an accepted proposal)
// and the web store (the optimistic paint, the undo) call it and keep no copy,
// so what a page paints is what the row stores.

/** The word for one entry of each list. */
export const INITIATIVE_RECORD_NOUN: Record<InitiativeRecordList, string> = { milestones: "milestone", questions: "question", decisions: "decision", sources: "source" };

/** How long each written part of an entry may be; a quote's limit is QUOTE_MAX. */
const ENTRY_MAX = { title: 200, text: 1000, by: 80, key: 64, ref: 500 } as const;

/** One edit of one list of the record, as `initiatives.record` reads it. */
export type InitiativeRecordOp = {
  list: InitiativeRecordList;
  action: "add" | "edit" | "close" | "remove";
  /** Which entry: required for edit, close and remove. */
  key?: string;
  /** add and edit: the entry's fields, where null clears one on an edit. A source may be `{ text }` or the text alone, read by parseIntentSource. */
  entry?: unknown;
  /** close: when the milestone was reached or the question answered. */
  at?: number;
  /** close on a question. */
  answer?: string;
  /** add: where in the list the entry lands, the end when absent. An undo of a remove names where the entry sat. */
  index?: number;
};

export type RecordOpResult = {
  /** The list as it then stands. */
  next: any[];
  /** The entry the op touched; absent when a remove found nothing. */
  entry?: any;
  /** Whether the list changed: a retried add, a repeated close, a remove that finds nothing and an edit that says what is there move nothing. */
  moved: boolean;
  /** The op with everything decided (the entry whole, its key, who and when): applied to the same list anywhere, it writes the same entry. */
  op: InitiativeRecordOp;
};

/** What names an entry in its list: its key, or a source's own address. */
export const recordKeyOf = (list: InitiativeRecordList, entry: any): string => (list === "sources" ? intentSourceKey(entry) : String(entry?.key ?? ""));

/** Whether an add leaves who asked or decided unsaid, so whoever makes it signs it: a new question or decision with no `by`. A `by` of null says nobody signs: an entry put back as it was. */
export const recordOpNeedsSignature = (op: InitiativeRecordOp): boolean =>
  op.action === "add" && (op.list === "questions" || op.list === "decisions") && !(isObject(op.entry) && (op.entry.by === null || (typeof op.entry.by === "string" && !!op.entry.by.trim())));

type Signer = { _id: unknown; name?: string | null; github_username?: string | null; email?: string | null; is_bot?: boolean };
/** Who signs a question or a decision that names nobody: the person's @handle where the roster reads that handle back as them, else their name, their GitHub name or their email. */
export function initiativeSignature(me: Signer | null | undefined, roster: readonly Signer[]): string | undefined {
  if (!me) return undefined;
  const handle = memberHandle(me);
  return handle && String(matchHandle(roster, handle)?._id ?? "") === String(me._id) ? `@${handle}` : me.name || me.github_username || me.email || undefined;
}

/** An entry as the row stores it: cleared fields gone and the rest sorted by name, a source inside it too, so two readings of one entry are the same JSON. */
export function storedEntry<T extends Record<string, any>>(entry: T): T {
  const out: Record<string, any> = {};
  for (const k of Object.keys(entry).sort()) {
    const value = entry[k];
    if (value === null || value === undefined || value === "") continue;
    out[k] = isObject(value) ? storedEntry(value) : value;
  }
  return out as T;
}

class RecordOpError extends Error {}
function refuse(message: string): never {
  throw new RecordOpError(message);
}
function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
const clip = (text: string, max: number): string => text.trim().slice(0, max);
/** Two readings of one entry are the same when they store the same. */
export const sameRecordEntry = (a: Record<string, any>, b: Record<string, any>): boolean => JSON.stringify(storedEntry(a)) === JSON.stringify(storedEntry(b));

type ReadField = (x: unknown, name: string) => unknown;
const words = (max: number): ReadField => (x, name) => (typeof x === "string" ? clip(x, max) || null : refuse(`${name} is text`));
/** A moment on the record is a real one: a finite time after the epoch, since 0 and NaN read as "never". */
const isMoment = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const moment: ReadField = (x, name) => (isMoment(x) ? x : refuse(`${name} is a time in milliseconds`));

/** A stored kind and ref read by the text parser's own address rules: a link is an http or https URL, a call line takes the shared form. Null when the ref is not an address of that kind. */
function sourceAddress(kind: IntentSourceKind, ref: string): Pick<IntentSource, "kind" | "ref"> | null {
  // A link stored as a link stays one, whatever its address reads as when typed.
  if (kind === "link") return isWebAddress(ref) ? { kind, ref } : null;
  const alone = readSourceRef(ref);
  if (alone?.kind === kind) return alone;
  const named = readSourceRef(`${kind}:${ref}`);
  return named?.kind === kind ? named : null;
}

// `key` is allowed and unread: a client that names every entry by key may send a source's address with it.
const SOURCE_FIELDS = ["kind", "ref", "quote", "by", "at", "text", "key"];
/** A source as the row stores it, from the stored shape, from `{ text }` or from the text alone. */
function readSource(raw: unknown): IntentSource {
  const given = typeof raw === "string" ? { text: raw } : raw;
  if (!isObject(given)) refuse("A source is an address, the words said, or both");
  const stray = Object.keys(given).find((k) => !SOURCE_FIELDS.includes(k));
  if (stray) refuse(`Not a field of a source: ${stray}`);
  const text = (k: string, max: number) => (typeof given[k] === "string" && clip(given[k] as string, max)) || undefined;
  const said = { quote: text("quote", QUOTE_MAX), by: text("by", ENTRY_MAX.by), at: isMoment(given.at) ? given.at : undefined };
  let source: IntentSource;
  if (typeof given.text === "string") source = parseIntentSource(given.text, said);
  else {
    const kind = given.kind as IntentSourceKind;
    if (!INTENT_SOURCE_KINDS.includes(kind)) refuse(`A source is one of ${INTENT_SOURCE_KINDS.join(", ")}`);
    const ref = kind === "note" ? undefined : text("ref", ENTRY_MAX.ref);
    const address = ref ? sourceAddress(kind, ref) ?? refuse(kind === "link" ? "A link is an http or https address" : `Not the address of a ${kind}: ${ref}`) : { kind };
    source = { ...address, ...said };
  }
  if (intentSourceKey(source).endsWith(":")) refuse("A source needs an address or the words said");
  return storedEntry(source);
}

type KeyedRecordList = Exclude<InitiativeRecordList, "sources">;
// What an entry of each keyed list may carry, and how each field is read.
const ENTRY_FIELDS: Record<KeyedRecordList, Record<string, ReadField>> = {
  milestones: { title: words(ENTRY_MAX.title), date: moment, done_at: moment, source: readSource },
  questions: { text: words(ENTRY_MAX.text), at: moment, by: words(ENTRY_MAX.by), source: readSource, answer: words(ENTRY_MAX.text), answered_at: moment },
  decisions: { text: words(ENTRY_MAX.text), at: moment, by: words(ENTRY_MAX.by), source: readSource },
};

/** The fields an entry names, each read by its rule; null stays null so an edit can clear with it. */
function readEntry(list: KeyedRecordList, raw: unknown): Record<string, any> {
  const noun = INITIATIVE_RECORD_NOUN[list];
  if (!isObject(raw)) refuse(`Give the ${noun} as an entry`);
  const out: Record<string, any> = {};
  for (const [k, value] of Object.entries(raw)) {
    if (k === "key" || value === undefined) continue;
    const read = ENTRY_FIELDS[list][k];
    if (!read) refuse(`Not a field of a ${noun}: ${k}`);
    out[k] = value === null ? null : read(value, `A ${noun}'s ${k}`);
  }
  return out;
}

const entryWords = (entry: Record<string, any>): string => String(entry.title ?? entry.text ?? "");

/** An entry as it is stored: its words present, a question and a decision always dated (clearing `at` keeps the date it had), and an answer always dated. */
function settleEntry(list: KeyedRecordList, fields: Record<string, any>, was: Record<string, any> | undefined, now: number): Record<string, any> {
  const e = storedEntry(fields);
  if (!entryWords(e)) refuse(`A ${INITIATIVE_RECORD_NOUN[list]} needs ${list === "milestones" ? "a title" : "words"}`);
  if (list !== "milestones") e.at ??= was?.at ?? now;
  if (list === "questions") {
    if (e.answer) e.answered_at ??= now;
    else delete e.answered_at;
  }
  return storedEntry(e);
}

/**
 * One op applied to one list. Pure: `now` and `by` (who signs an add that
 * names nobody, see recordOpNeedsSignature) are the only things it does not
 * read from the list and the op, and the op it hands back carries both, so
 * the server applying that op stores the entry the client painted. An op
 * that cannot be applied answers `{ error }` in words a person can act on;
 * `goal` names the goal in them.
 */
export function applyRecordOp(prior: readonly any[] | undefined, op: InitiativeRecordOp, ctx: { now: number; by?: string; goal?: string }): RecordOpResult | { error: string } {
  try {
    return recordOp(prior ?? [], op, ctx);
  } catch (e) {
    if (e instanceof RecordOpError) return { error: e.message };
    throw e;
  }
}

function recordOp(prior: readonly any[], op: InitiativeRecordOp, ctx: { now: number; by?: string; goal?: string }): RecordOpResult {
  const { list } = op;
  const noun = INITIATIVE_RECORD_NOUN[list];
  if (!noun) refuse(`A record list is one of ${INITIATIVE_RECORD_LISTS.join(", ")}`);
  const keyOf = (e: any) => recordKeyOf(list, e);
  const keys = prior.map(keyOf);
  const unmoved = (entry: any, settled: InitiativeRecordOp): RecordOpResult => ({ next: prior as any[], entry, moved: false, op: settled });

  if (op.action === "add") {
    let entry: Record<string, any>;
    if (list === "sources") entry = readSource(op.entry);
    else {
      const fields = readEntry(list, op.entry);
      const given = isObject(op.entry) && typeof op.entry.key === "string" ? clip(op.entry.key, ENTRY_MAX.key) : "";
      // Who asked or decided, and when: the caller and now, unless the entry says.
      const signed = list === "milestones" ? {} : { at: fields.at ?? ctx.now, by: recordOpNeedsSignature(op) ? ctx.by : fields.by };
      entry = settleEntry(list, { ...fields, ...signed, key: given || recordEntryKey(entryWords(fields), keys) }, undefined, ctx.now);
      // A key already on the list with the same words is a retried add. With
      // other words it is a different entry whose key reads the same (two
      // texts with one slug, written before either had synced): it is kept
      // under a fresh key, never dropped as a retry.
      const clash = prior[keys.indexOf(entry.key)];
      if (clash && entryWords(clash) !== entryWords(entry)) entry = { ...entry, key: recordEntryKey(entryWords(entry), keys) };
    }
    // A retried add, or a source already on the record: the entry there stands.
    const there = keys.indexOf(keyOf(entry));
    if (there >= 0) return unmoved(prior[there], { list, action: "add", entry: prior[there] });
    if (prior.length >= INITIATIVE_RECORD_MAX[list]) refuse(`A goal holds at most ${INITIATIVE_RECORD_MAX[list]} ${list}`);
    if (op.index !== undefined && !(Number.isInteger(op.index) && op.index >= 0)) refuse("An index is a whole number from 0");
    const index = Math.min(op.index ?? prior.length, prior.length);
    // The op says who signed even when nobody did, so the next reader of it does not sign in their place.
    const whole = list === "questions" || list === "decisions" ? { ...entry, by: entry.by ?? null } : entry;
    return { next: [...prior.slice(0, index), entry, ...prior.slice(index)], entry, moved: true, op: { list, action: "add", entry: whole, ...(op.index === undefined ? {} : { index }) } };
  }

  const key = typeof op.key === "string" ? op.key : "";
  if (!key) refuse(`Name the ${noun} by its key`);
  const at = keys.indexOf(key);
  // A retried remove finds nothing and changes nothing.
  if (op.action === "remove") {
    const settled: InitiativeRecordOp = { list, action: "remove", key };
    return at < 0 ? unmoved(undefined, settled) : { next: prior.filter((_, i) => i !== at), entry: prior[at], moved: true, op: settled };
  }
  if (at < 0) refuse(`No ${noun} ${key} on ${ctx.goal ?? "this goal"}`);
  const was: Record<string, any> = prior[at];
  let entry: Record<string, any>;
  let settled: InitiativeRecordOp;
  if (op.action === "close") {
    // A close said twice is one close: the first date stands unless this one names another.
    const when = op.at === undefined ? undefined : (moment(op.at, list === "milestones" ? "When a milestone was reached" : "When a question was answered") as number);
    if (list === "milestones") {
      const done_at = when ?? was.done_at ?? ctx.now;
      entry = { ...was, done_at };
      settled = { list, action: "close", key, at: done_at };
    } else if (list === "questions") {
      const answer = clip(typeof op.answer === "string" ? op.answer : "", ENTRY_MAX.text);
      if (!answer) refuse("An answer needs words");
      const answered_at = when ?? (was.answer === answer ? was.answered_at : undefined) ?? ctx.now;
      entry = { ...was, answer, answered_at };
      settled = { list, action: "close", key, at: answered_at, answer };
    } else refuse(`A ${noun} is edited or removed; only a milestone is reached and a question answered`);
  } else if (list === "sources") {
    if (!isObject(op.entry)) refuse("Give the source as an entry");
    // New text is read whole, keeping who said it and when unless the edit names them.
    entry = readSource(typeof op.entry.text === "string" ? { by: was.by, at: was.at, ...op.entry } : { ...was, ...op.entry });
    if (keyOf(entry) !== key && keys.includes(keyOf(entry))) refuse("That source is already on the record");
    settled = { list, action: "edit", key, entry: { ...Object.fromEntries(Object.keys(was).filter((k) => !(k in entry)).map((k) => [k, null])), ...entry } };
  } else {
    const fields = readEntry(list, op.entry);
    entry = settleEntry(list, { ...was, ...fields }, was, ctx.now);
    // The two dates this reducer decides ride the op when they moved.
    const decided = Object.fromEntries((["at", "answered_at"] as const).filter((k) => entry[k] !== was[k]).map((k) => [k, entry[k] ?? null]));
    settled = { list, action: "edit", key, entry: { ...fields, ...decided } };
  }
  entry = storedEntry(entry);
  if (sameRecordEntry(entry, was)) return unmoved(was, settled);
  return { next: prior.map((e, i) => (i === at ? entry : e)), entry, moved: true, op: settled };
}

/** Milestones in reading order: dated ones by day, then undated ones as written. */
export function orderedMilestones(milestones: readonly InitiativeMilestone[] | undefined): InitiativeMilestone[] {
  return (milestones ?? []).map((m, i) => ({ m, i })).sort((a, b) => (a.m.date ?? Infinity) - (b.m.date ?? Infinity) || a.i - b.i).map((x) => x.m);
}
/** The next milestone: the first one not reached, earliest day first. Null when every one is reached or none is set. */
export const nextMilestone = (row: Pick<InitiativeRow, "milestones">): InitiativeMilestone | null => orderedMilestones(row.milestones).find((m) => !m.done_at) ?? null;
/** "3 of 5 reached" as counts. */
export const milestoneCounts = (row: Pick<InitiativeRow, "milestones">): { done: number; total: number } => ({ done: (row.milestones ?? []).filter((m) => m.done_at).length, total: (row.milestones ?? []).length });
export const openQuestions = (row: Pick<InitiativeRow, "questions">): InitiativeQuestion[] => (row.questions ?? []).filter((q) => !q.answer);

/** Add a reported value to a metric's history, oldest first, the newest INITIATIVE_SCORE_HISTORY_MAX kept. A second report for the same moment replaces the first. */
export function appendScoreHistory(history: Record<string, InitiativeScore[]> | undefined, key: string, score: InitiativeScore): Record<string, InitiativeScore[]> {
  const series = [...(history?.[key] ?? []).filter((s) => s.observed_at !== score.observed_at), score].sort((a, b) => a.observed_at - b.observed_at);
  return { ...(history ?? {}), [key]: series.slice(-INITIATIVE_SCORE_HISTORY_MAX) };
}

/**
 * What a metric edit does to the values reported under each key (`scoreboard`
 * or `score_history`): a key that stays keeps its values and a key that goes
 * takes them with it. A rename moves the key, since every caller derives it
 * from the name: a new key standing where a key that goes stood is that
 * metric renamed, and takes its values. Undefined when none are left.
 */
export function carryMetricScores<T>(was: readonly InitiativeMetric[] | undefined, now: readonly InitiativeMetric[] | undefined, byKey: Record<string, T> | undefined): Record<string, T> | undefined {
  const before = was ?? [];
  const after = now ?? [];
  const has = (list: readonly InitiativeMetric[], key: string) => list.some((m) => m.key === key);
  const renamed = new Map(after.flatMap((m, i) => (before[i] && !has(before, m.key) && !has(after, before[i].key) ? [[before[i].key, m.key] as const] : [])));
  const out = Object.fromEntries(Object.entries(byKey ?? {}).map(([k, value]) => [renamed.get(k) ?? k, value] as const).filter(([k]) => has(after, k)));
  return Object.keys(out).length ? out : undefined;
}

export type MetricTrend = {
  /** Which way the number moved between the first and the last report read. */
  direction: "up" | "down" | "flat" | "unknown";
  /** Whether that is toward the target; null when flat or unknown. */
  toward: boolean | null;
  /** The change between the previous report and the latest, as a number; null when either is unread. */
  delta: number | null;
  /** The readable values oldest first, for a sparkline. */
  series: Array<{ at: number; n: number }>;
};

/** A metric's history read as a direction and a series. `window` is how many of the latest reports to read. */
export function metricTrend(history: readonly InitiativeScore[] | undefined, target: string, window = 12): MetricTrend {
  const series = (history ?? []).map((s) => ({ at: s.observed_at, n: metricNumber(s.value) })).filter((p): p is { at: number; n: number } => p.n !== null).sort((a, b) => a.at - b.at).slice(-window);
  if (series.length < 2) return { direction: "unknown", toward: null, delta: null, series };
  const first = series[0].n, last = series[series.length - 1].n;
  const span = Math.max(Math.abs(first), Math.abs(last), 1e-9);
  const direction = Math.abs(last - first) / span < 0.005 ? "flat" : last > first ? "up" : "down";
  const toward = direction === "flat" ? null : (metricDirection(target) === "at_most") === (direction === "down");
  return { direction, toward, delta: last - series[series.length - 2].n, series };
}
export const metricTrends = (row: Pick<InitiativeRow, "metrics" | "score_history">): Record<string, MetricTrend> => Object.fromEntries((row.metrics ?? []).map((m) => [m.key, metricTrend(row.score_history?.[m.key], m.target)]));

/** "up from 380, toward the target" for a terminal and a prompt; empty before two reports. */
export function trendWords(t: MetricTrend): string {
  if (t.direction === "unknown") return "";
  if (t.direction === "flat") return "flat";
  const from = t.series[0]?.n;
  return `${t.direction}${from !== undefined ? ` from ${formatMetricNumber(from)}` : ""}${t.toward === null ? "" : t.toward ? ", toward the target" : ", away from the target"}`;
}
/** 1234.5 → "1,234.5"; whole numbers print whole. */
export const formatMetricNumber = (n: number): string => (Number.isInteger(n) ? n : Math.round(n * 100) / 100).toLocaleString("en-US");

export type InitiativeLink = { short_id: string; title: string };
/**
 * The goals above this one, nearest first, up to the top level goal: what a
 * role's work feeds. Cycles and missing rows end the walk.
 */
export function initiativeChain<T extends { _id: string; short_id: string; title: string; parent_initiative_id?: string }>(row: T, byId: (id: string) => T | undefined): InitiativeLink[] {
  const out: InitiativeLink[] = [];
  const seen = new Set<string>([row._id]);
  let cur: T | undefined = row;
  while (cur?.parent_initiative_id && !seen.has(cur.parent_initiative_id)) {
    seen.add(cur.parent_initiative_id);
    cur = byId(cur.parent_initiative_id);
    if (!cur) break;
    out.push({ short_id: cur.short_id, title: cur.title });
  }
  return out;
}
/** "Win the private network, under Reach 1k teams" */
export const chainLine = (chain: InitiativeLink[]): string => chain.length ? `under ${chain.map((c) => c.title).join(", under ")}` : "";

export type InitiativeRow = {
  _id: string;
  /** "in-N". */
  short_id: string;
  /** The optimistic stub's own key; the server row carrying it supersedes the stub. */
  client_key?: string;
  title: string;
  /** The goal in a few sentences: its scope and context. */
  description?: string;
  status: InitiativeStatus;
  /** Absent means nobody drives it, which is the first finding of a review. */
  owner?: InitiativeOwner;
  target_date?: number;
  priority?: InitiativePriority;
  labels?: string[];
  /** Project ids in the order the owner arranged them. A project may sit in several initiatives. */
  project_ids: string[];
  /** One level of nesting: a row that has a parent is never a parent itself. The parent is the top level goal this one feeds. */
  parent_initiative_id?: string;
  /** One or two numbers the goal is measured by, each with a target (at most INITIATIVE_METRICS_MAX). */
  metrics?: InitiativeMetric[];
  /** The reported values by metric key, with a source and a date each (the template scoreboard's shape). The latest of `score_history`. */
  scoreboard?: Record<string, InitiativeScore>;
  /** Every reported value by metric key, oldest first (I5): what the trend is read from. Written only with `scoreboard`. */
  score_history?: Record<string, InitiativeScore[]>;
  /** Why it matters. */
  why?: string;
  /** What done looks like: the sentence a result is checked against. */
  done_when?: string;
  /** Steps on the way; the next one is the first not reached (nextMilestone). */
  milestones?: InitiativeMilestone[];
  /** What is still undecided, and what was answered. */
  questions?: InitiativeQuestion[];
  /** What was decided, newest last. */
  decisions?: InitiativeDecision[];
  /** Where the goal was stated: who said it and where. */
  sources?: IntentSource[];
  /** Copied from the latest update when it is posted; `none` before one exists. */
  health: InitiativeHealth;
  /** When the latest update was posted, so a list shows the date with no updates loaded. */
  health_at?: number;
  latest_update_id?: string;
  /** ACCESS. */
  workspace: string;
  /** ROUTING. */
  team_id?: string;
  /** Who created it. Named `user_id` because the access stamp reads that field on every table. */
  user_id: string;
  created_at: number;
  updated_at: number;
};

export type InitiativeUpdateRow = {
  _id: string;
  client_key?: string;
  initiative_id: string;
  body: string;
  health: InitiativeUpdateHealth;
  by: InitiativeUpdateAuthor;
  at: number;
  workspace: string;
  user_id: string;
};

/** Reads `in-7`, `IN-7` and a bare `7` as the short id; anything else is returned untouched (a Convex id). */
export function normalizeInitiativeRef(ref: string): string {
  const t = (ref || "").trim();
  if (/^\d+$/.test(t)) return `in-${t}`;
  return /^in-\d+$/i.test(t) ? t.toLowerCase() : t;
}
