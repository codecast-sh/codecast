// One edit of a goal's intent record
// (docs/architecture/initiatives-projects-role-page.md I5), settled on the
// client the way `initiatives.record` settles it on the server: the entry's
// key, who and when are decided here, so the op the store paints is the op the
// server stores and the echo equals the draft. Pure and import free of the
// store, so the slice and the undo writer both read it.
import { INITIATIVE_RECORD_MAX, intentSourceKey, parseIntentSource, recordEntryKey, type InitiativeRecordList } from "@codecast/shared/contracts/initiative";

/** The op `initiatives.record` reads. */
export type InitiativeRecordOp = {
  list: InitiativeRecordList;
  action: "add" | "edit" | "close" | "remove";
  /** Which entry: required for edit, close and remove. */
  key?: string;
  /** add and edit: the entry's fields, where null clears one on an edit. A new source may be `{ text, by? }`, read by parseIntentSource. */
  entry?: Record<string, any>;
  /** close: when the milestone was reached or the question answered. */
  at?: number;
  /** close on a question. */
  answer?: string;
};

/** What names an entry in its list: its key, or a source's own address. */
export const recordKeyOf = (list: InitiativeRecordList, entry: any): string => (list === "sources" ? intentSourceKey(entry) : String(entry?.key ?? ""));

/** An entry as the row stores it: cleared fields gone, and its fields in the
 *  order the server hands them back (an object's fields come back sorted by
 *  name). Field locks compare objects as JSON, so this is what lets the lock
 *  on the list retire when the echo lands. */
export function asStoredEntry<T extends Record<string, any>>(entry: T): T {
  const out: Record<string, any> = {};
  for (const k of Object.keys(entry).sort()) {
    const v = entry[k];
    if (v === null || v === undefined || v === "") continue;
    out[k] = typeof v === "object" && !Array.isArray(v) ? asStoredEntry(v) : v;
  }
  return out as T;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A source as the row stores it, from the stored shape or from `{ text, by? }`
 *  as a person typed it. Undefined when it names no address and says nothing. */
function storedSource(given: Record<string, any> | null | undefined): Record<string, any> | undefined {
  if (!given) return undefined;
  const { text, key: _key, ...rest } = given;
  const source = asStoredEntry(typeof text === "string" ? parseIntentSource(text, rest) : rest);
  return source.kind && !intentSourceKey(source as any).endsWith(":") ? source : undefined;
}

/**
 * One op applied to one list: the list as it then stands and the op to send,
 * carrying the whole entry it wrote. Null when the op moves nothing: no words,
 * an entry already there, a full list, a key that names nothing.
 */
export function settleRecordOp(prior: readonly any[], op: InitiativeRecordOp, who: { by?: string; now: number }): { next: any[]; op: InitiativeRecordOp } | null {
  const { list } = op;
  const keyOf = (e: any) => recordKeyOf(list, e);

  if (op.action === "add") {
    let entry: Record<string, any>;
    if (list === "sources") {
      const source = storedSource(op.entry);
      if (!source) return null;
      entry = source;
    } else {
      const given = op.entry ?? {};
      const words = String((list === "milestones" ? given.title : given.text) ?? "").trim();
      if (!words) return null;
      entry = asStoredEntry({
        ...given,
        ...(list === "milestones" ? { title: words } : { text: words, at: given.at ?? who.now, by: given.by ?? who.by }),
        source: storedSource(given.source),
        key: given.key || recordEntryKey(words, prior.map(keyOf)),
      });
    }
    if (prior.some((e) => keyOf(e) === keyOf(entry)) || prior.length >= INITIATIVE_RECORD_MAX[list]) return null;
    return { next: [...prior, entry], op: { list, action: "add", entry } };
  }

  const at = prior.findIndex((e) => keyOf(e) === op.key);
  if (at < 0 || !op.key) return null;
  if (op.action === "remove") return { next: prior.filter((_, i) => i !== at), op: { list, action: "remove", key: op.key } };

  const was = prior[at];
  let entry: Record<string, any>;
  let wire: InitiativeRecordOp;
  if (op.action === "close") {
    if (list === "milestones") {
      const done_at = op.at ?? was.done_at ?? who.now;
      entry = { ...was, done_at };
      wire = { list, action: "close", key: op.key, at: done_at };
    } else if (list === "questions") {
      const answer = (op.answer ?? "").trim();
      if (!answer) return null;
      const answered_at = op.at ?? who.now;
      entry = { ...was, answer, answered_at };
      wire = { list, action: "close", key: op.key, at: answered_at, answer };
    } else return null;
  } else {
    const { key: _key, ...fields } = op.entry ?? {};
    if (list !== "sources" && fields.source) fields.source = storedSource(fields.source) ?? null;
    entry = { ...was, ...fields };
    // An answer is always dated, and a question with none has no date.
    if (list === "questions") entry.answered_at = entry.answer ? (entry.answered_at ?? who.now) : null;
    wire = { list, action: "edit", key: op.key, entry: list === "questions" && entry.answered_at !== (was.answered_at ?? null) ? { ...fields, answered_at: entry.answered_at } : fields };
  }
  entry = asStoredEntry(entry);
  if (same(entry, was)) return null;
  if (keyOf(entry) !== op.key && prior.some((e) => keyOf(e) === keyOf(entry))) return null;
  return { next: prior.map((e, i) => (i === at ? entry : e)), op: wire };
}

/**
 * The ops that take a list from how it stands to how it was: an entry that
 * was not there is removed, one that is gone is added back whole, and one
 * that changed is edited to its prior fields (null for each it did not have).
 * An entry added back lands at the end, which is the only place the record
 * adds one.
 */
export function recordOpsBetween(list: InitiativeRecordList, current: readonly any[] | undefined, prior: readonly any[] | undefined): InitiativeRecordOp[] {
  const now = current ?? [];
  const was = prior ?? [];
  const keyOf = (e: any) => recordKeyOf(list, e);
  const wasByKey = new Map(was.map((e) => [keyOf(e), e]));
  const nowByKey = new Map(now.map((e) => [keyOf(e), e]));
  const ops: InitiativeRecordOp[] = [];
  for (const e of now) if (!wasByKey.has(keyOf(e))) ops.push({ list, action: "remove", key: keyOf(e) });
  for (const e of was) {
    const cur = nowByKey.get(keyOf(e));
    if (!cur) ops.push({ list, action: "add", entry: e });
    else if (!same(cur, e)) ops.push({ list, action: "edit", key: keyOf(e), entry: { ...Object.fromEntries(Object.keys(cur).filter((k) => !(k in e)).map((k) => [k, null])), ...e } });
  }
  return ops;
}
