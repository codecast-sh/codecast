/**
 * Drafting markup: the editing aids a writer leaves in a doc while it is still
 * being worked (after Jason Fried's Write_On). They live in the doc's own
 * markdown as inline spans, so the collab editor, `cast doc` verbs, agents
 * reading a doc and every renderer see the same thing:
 *
 *   <span data-alts='[...]' data-alt-at="1">pressure</span>
 *     Alternatives. The span's text is the version shown now; `data-alts`
 *     holds every OTHER version, in order, and `data-alt-at` is where the
 *     shown one sits in the full list. Index 0 of the full list is the
 *     original, so `at > 0` reads "on a variation". The shown text has one
 *     home (the span), so editing it in place can never disagree with a copy.
 *
 *   <span data-ghost="">maybe cut this</span>
 *     Ghosted: still in the doc, dimmed back. A reason marks a proposal
 *     (`data-ghost="trim"`): cuts suggested by the Lab or an agent that the
 *     writer keeps or makes.
 *
 *   <span data-flag="convoluted" data-note="...">sentence</span>
 *     A Lab finding on a stretch of text. Never changes the words.
 *
 * Everything here is pure string work on markdown so the CLI, convex and the
 * web share it. The editor marks serialize through `openTag` so the editor
 * and the CLI write byte-identical markup.
 */

export interface AltOption {
  /** The text of this version. */
  t: string;
  /** Written by a model rather than the writer. */
  ai?: boolean;
}

export type DraftKind = "alts" | "ghost" | "flag";

export interface AltAttrs {
  alts: AltOption[];
  at: number;
  /** The shown version came from a model. */
  ai?: boolean;
}

export interface GhostAttrs {
  reason: string;
}

export interface FlagAttrs {
  flag: string;
  note?: string;
}

/** Lab trims propose cuts with this ghost reason. */
export const TRIM_REASON = "trim";

/** Every Lab flag kind, with the words the UI shows for it. */
export const FLAG_LABELS: Record<string, string> = {
  weak: "Weak sentence",
  long: "Runs long",
  convoluted: "Convoluted",
  tone: "Off tone",
  filler: "Hedge or filler",
};

function escapeAttr(value: string, quote: "'" | '"' = '"'): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(quote === "'" ? /'/g : /"/g, quote === "'" ? "&#39;" : "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function normalizeAlts(raw: unknown): AltOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o: any) => (typeof o === "string" ? { t: o } : o && typeof o.t === "string" ? { t: o.t, ...(o.ai ? { ai: true } : {}) } : null))
    .filter((o): o is AltOption => !!o && o.t.length > 0);
}

/** The opening tag for a drafting span. The editor marks serialize through this too. */
export function openTag(kind: "alts", attrs: AltAttrs): string;
export function openTag(kind: "ghost", attrs: GhostAttrs): string;
export function openTag(kind: "flag", attrs: FlagAttrs): string;
export function openTag(kind: DraftKind, attrs: any): string {
  if (kind === "alts") {
    const a = attrs as AltAttrs;
    const json = JSON.stringify(normalizeAlts(a.alts).map((o) => (o.ai ? { t: o.t, ai: 1 } : { t: o.t })));
    return `<span data-alts='${escapeAttr(json, "'")}' data-alt-at="${Math.max(0, a.at | 0)}"${a.ai ? ' data-alt-ai="1"' : ""}>`;
  }
  if (kind === "ghost") return `<span data-ghost="${escapeAttr((attrs as GhostAttrs).reason ?? "")}">`;
  const f = attrs as FlagAttrs;
  return `<span data-flag="${escapeAttr(f.flag)}"${f.note ? ` data-note="${escapeAttr(f.note)}"` : ""}>`;
}

export const CLOSE_TAG = "</span>";

function readAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`));
  if (!m) return null;
  return unescapeAttr(m[1] ?? m[2] ?? "");
}

/** Parse the attributes of a drafting span's opening tag, or null for any other tag. */
export function parseOpenTag(tag: string):
  | { kind: "alts"; attrs: AltAttrs }
  | { kind: "ghost"; attrs: GhostAttrs }
  | { kind: "flag"; attrs: FlagAttrs }
  | null {
  const alts = readAttr(tag, "data-alts");
  if (alts !== null) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(alts);
    } catch {}
    const at = Number(readAttr(tag, "data-alt-at") ?? 0);
    return { kind: "alts", attrs: { alts: normalizeAlts(parsed), at: Number.isFinite(at) ? at : 0, ...(readAttr(tag, "data-alt-ai") ? { ai: true } : {}) } };
  }
  const ghost = readAttr(tag, "data-ghost");
  if (ghost !== null) return { kind: "ghost", attrs: { reason: ghost } };
  const flag = readAttr(tag, "data-flag");
  if (flag !== null) return { kind: "flag", attrs: { flag, ...(readAttr(tag, "data-note") ? { note: readAttr(tag, "data-note")! } : {}) } };
  return null;
}

/** The full ordered list of versions for an alternatives span, shown text included. */
export function fullAltList(attrs: AltAttrs, shown: string): AltOption[] {
  const at = Math.min(Math.max(0, attrs.at), attrs.alts.length);
  const list = [...attrs.alts];
  list.splice(at, 0, { t: shown, ...(attrs.ai ? { ai: true } : {}) });
  return list;
}

/** Split a full list back into stored attrs with `index` as the shown version. */
export function altAttrsFor(full: AltOption[], index: number): { attrs: AltAttrs; shown: string } {
  const i = Math.min(Math.max(0, index), full.length - 1);
  const shown = full[i];
  return {
    attrs: { alts: full.filter((_, j) => j !== i), at: i, ...(shown.ai ? { ai: true } : {}) },
    shown: shown.t,
  };
}

/**
 * "a thumbtack" -> "an eraser": fix the article before a swapped word so the
 * sentence keeps reading right. `before` is the text immediately preceding the
 * span; returns the corrected preceding text (unchanged when no article).
 */
export function agreeArticle(before: string, next: string): string {
  const m = before.match(/(^|[^A-Za-z])(a|an|A|An)(\s+)$/);
  if (!m) return before;
  const vowel = startsWithVowelSound(next);
  const lower = m[2].toLowerCase();
  const want = vowel ? "an" : "a";
  if (lower === want) return before;
  const cased = m[2][0] === "A" ? want[0].toUpperCase() + want.slice(1) : want;
  return before.slice(0, before.length - m[2].length - m[3].length) + cased + m[3];
}

const SILENT_H = /^(hour|honest|honor|honour|heir)/i;
const YOU_SOUND = /^(uni|use|usu|uti|euro|eu|one|once|ubi|ure)/i;

export function startsWithVowelSound(word: string): boolean {
  const w = word.trim().replace(/^["'“‘(]+/, "");
  if (!w) return false;
  if (SILENT_H.test(w)) return true;
  if (YOU_SOUND.test(w)) return false;
  if (/^[0-9]/.test(w)) return /^(8|11|18)/.test(w);
  return /^[aeiou]/i.test(w);
}

// ── Locating drafting spans in markdown ─────────────────────────────

export interface DraftSpan {
  kind: DraftKind;
  attrs: AltAttrs | GhostAttrs | FlagAttrs;
  /** Offset of the opening `<span`. */
  start: number;
  /** Offset just past the closing `</span>`. */
  end: number;
  /** Offset just past the opening tag. */
  innerStart: number;
  /** Offset of the closing tag. */
  innerEnd: number;
  inner: string;
}

/** Every drafting span in the markdown, outermost first, nested ones included. */
export function findDraftSpans(md: string): DraftSpan[] {
  const out: DraftSpan[] = [];
  const re = /<span\b[^>]*>|<\/span>/g;
  const stack: Array<{ tag: string; start: number; innerStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m[0] === CLOSE_TAG) {
      const open = stack.pop();
      if (!open) continue;
      const parsed = parseOpenTag(open.tag);
      if (!parsed) continue;
      out.push({
        kind: parsed.kind,
        attrs: parsed.attrs,
        start: open.start,
        end: m.index + CLOSE_TAG.length,
        innerStart: open.innerStart,
        innerEnd: m.index,
        inner: md.slice(open.innerStart, m.index),
      });
    } else {
      stack.push({ tag: m[0], start: m.index, innerStart: m.index + m[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Markdown with every drafting span unwrapped (text kept). `dropGhosts` also deletes ghosted text. */
export function stripDrafting(md: string, opts: { dropGhosts?: boolean } = {}): string {
  let out = md;
  // Innermost first, so offsets of the enclosing spans stay valid as we go.
  const spans = findDraftSpans(md).sort((a, b) => b.start - a.start);
  for (const s of spans) {
    const replacement = opts.dropGhosts && s.kind === "ghost" ? "" : out.slice(s.innerStart, s.innerEnd);
    out = out.slice(0, s.start) + replacement + out.slice(s.end);
  }
  if (opts.dropGhosts) out = tidySpacing(out);
  return out;
}

/** Collapse the doubled spaces and space-before-punctuation a deleted span leaves. */
export function tidySpacing(md: string): string {
  return md
    .split("\n")
    .map((line) => line.replace(/(\S) {2,}(?=\S)/g, "$1 ").replace(/ +([,.;:!?])/g, "$1").replace(/[ \t]+$/g, ""))
    .join("\n");
}

export class DraftTargetError extends Error {}

/**
 * Find `target` as literal text in the markdown. `occurrence` is 1-based.
 * The match must not cut through a tag, so wrapping it stays well formed.
 */
export function locate(md: string, target: string, occurrence = 1): { start: number; end: number } {
  if (!target) throw new DraftTargetError("Empty target text");
  let from = 0;
  let found = -1;
  for (let n = 0; n < occurrence; n++) {
    found = md.indexOf(target, from);
    if (found < 0) break;
    from = found + 1;
  }
  if (found < 0) {
    const count = md.split(target).length - 1;
    throw new DraftTargetError(
      count === 0
        ? `"${target}" is not in the doc`
        : `"${target}" appears ${count} time${count === 1 ? "" : "s"}; occurrence ${occurrence} does not exist`,
    );
  }
  const end = found + target.length;
  const tags = /<\/?span\b[^>]*>/g;
  let t: RegExpExecArray | null;
  while ((t = tags.exec(md))) {
    const tStart = t.index;
    const tEnd = t.index + t[0].length;
    if ((tStart < found && tEnd > found) || (tStart < end && tEnd > end)) {
      throw new DraftTargetError(`"${target}" cuts through drafting markup; pick text inside or around it`);
    }
  }
  return { start: found, end };
}

/** The innermost span of `kind` whose shown text is exactly `target` (or that contains it). */
function spanAt(md: string, kind: DraftKind, range: { start: number; end: number }): DraftSpan | null {
  const hits = findDraftSpans(md).filter((s) => s.kind === kind && s.innerStart <= range.start && s.innerEnd >= range.end);
  return hits.sort((a, b) => b.start - a.start)[0] ?? null;
}

function count(md: string, target: string): number {
  return target ? md.split(target).length - 1 : 0;
}

function needUnique(md: string, target: string, occurrence?: number) {
  if (occurrence === undefined && count(md, target) > 1) {
    throw new DraftTargetError(`"${target}" appears ${count(md, target)} times; pass an occurrence (--nth)`);
  }
}

/**
 * Add versions for `target`. When it is already the shown text of an
 * alternatives span, the new versions join that list; otherwise the text is
 * wrapped and becomes the original.
 */
export function addAlternatives(
  md: string,
  target: string,
  options: string[],
  opts: { ai?: boolean; occurrence?: number } = {},
): string {
  needUnique(md, target, opts.occurrence);
  const range = locate(md, target, opts.occurrence ?? 1);
  const fresh = options.map((t) => t.trim()).filter(Boolean);
  if (!fresh.length) throw new DraftTargetError("No alternatives given");
  const existing = spanAt(md, "alts", range);
  if (existing && existing.inner === target) {
    const attrs = existing.attrs as AltAttrs;
    const known = new Set([target, ...attrs.alts.map((o) => o.t)]);
    const added = fresh.filter((t) => !known.has(t)).map((t) => ({ t, ...(opts.ai ? { ai: true } : {}) }));
    const next = { ...attrs, alts: [...attrs.alts, ...added] };
    return md.slice(0, existing.start) + openTag("alts", next) + existing.inner + CLOSE_TAG + md.slice(existing.end);
  }
  const alts = [...new Set(fresh.filter((t) => t !== target))].map((t) => ({ t, ...(opts.ai ? { ai: true } : {}) }));
  return md.slice(0, range.start) + openTag("alts", { alts, at: 0 }) + target + CLOSE_TAG + md.slice(range.end);
}

/** Show version `index` (0 = original) of the alternatives span whose shown text is `target`. */
export function pickAlternative(md: string, target: string, index: number, opts: { occurrence?: number } = {}): string {
  needUnique(md, target, opts.occurrence);
  const range = locate(md, target, opts.occurrence ?? 1);
  const span = spanAt(md, "alts", range);
  if (!span || span.inner !== target) throw new DraftTargetError(`"${target}" has no alternatives`);
  const full = fullAltList(span.attrs as AltAttrs, span.inner);
  if (index < 0 || index >= full.length) throw new DraftTargetError(`Pick 0-${full.length - 1}`);
  const { attrs, shown } = altAttrsFor(full, index);
  const before = agreeArticle(md.slice(0, span.start), shown);
  return before + openTag("alts", attrs) + shown + CLOSE_TAG + md.slice(span.end);
}

/** Drop version `index` (never the one showing) from the set whose shown text is `target`. */
export function dropAlternative(md: string, target: string, index: number, opts: { occurrence?: number } = {}): string {
  needUnique(md, target, opts.occurrence);
  const range = locate(md, target, opts.occurrence ?? 1);
  const span = spanAt(md, "alts", range);
  if (!span || span.inner !== target) throw new DraftTargetError(`"${target}" has no alternatives`);
  const full = fullAltList(span.attrs as AltAttrs, span.inner);
  const at = Math.min((span.attrs as AltAttrs).at, full.length - 1);
  if (index === at) throw new DraftTargetError("That version is showing; pick another first");
  if (index < 0 || index >= full.length) throw new DraftTargetError(`Versions are 0-${full.length - 1}`);
  const rest = full.filter((_, i) => i !== index);
  if (rest.length < 2) return md.slice(0, span.start) + span.inner + md.slice(span.end);
  const { attrs } = altAttrsFor(rest, index < at ? at - 1 : at);
  return md.slice(0, span.start) + openTag("alts", attrs) + span.inner + CLOSE_TAG + md.slice(span.end);
}

/** Remove the alternatives on `target`, keeping the version shown now (or `keep`). */
export function settleAlternatives(md: string, target: string, opts: { occurrence?: number; keep?: number } = {}): string {
  const picked = opts.keep === undefined ? md : pickAlternative(md, target, opts.keep, opts);
  const shown = opts.keep === undefined ? target : fullAltList(spanAt(md, "alts", locate(md, target, opts.occurrence ?? 1))!.attrs as AltAttrs, target)[opts.keep].t;
  needUnique(picked, shown, opts.occurrence);
  const range = locate(picked, shown, opts.occurrence ?? 1);
  const span = spanAt(picked, "alts", range);
  if (!span) throw new DraftTargetError(`"${target}" has no alternatives`);
  return picked.slice(0, span.start) + span.inner + picked.slice(span.end);
}

/** Wrap `target` in a ghost span (dimmed back). A reason marks a proposed cut. */
export function ghostText(md: string, target: string, opts: { reason?: string; occurrence?: number } = {}): string {
  needUnique(md, target, opts.occurrence);
  const range = locate(md, target, opts.occurrence ?? 1);
  const existing = spanAt(md, "ghost", range);
  if (existing && existing.inner === target) return md;
  return md.slice(0, range.start) + openTag("ghost", { reason: opts.reason ?? "" }) + target + CLOSE_TAG + md.slice(range.end);
}

/** Bring ghosted text back: the span around `target`, or every ghost (optionally of one reason). */
export function reviveText(md: string, target?: string, opts: { reason?: string; occurrence?: number } = {}): string {
  if (target) {
    needUnique(md, target, opts.occurrence);
    const span = spanAt(md, "ghost", locate(md, target, opts.occurrence ?? 1));
    if (!span) throw new DraftTargetError(`"${target}" is not ghosted`);
    return md.slice(0, span.start) + span.inner + md.slice(span.end);
  }
  return rewriteSpans(md, (s) => s.kind === "ghost" && (opts.reason === undefined || (s.attrs as GhostAttrs).reason === opts.reason), "unwrap");
}

/** Delete ghosted text: proposed cuts of `reason` (default trim), or every ghost when reason is "*". */
export function makeCuts(md: string, reason: string = TRIM_REASON): string {
  return tidySpacing(rewriteSpans(md, (s) => s.kind === "ghost" && (reason === "*" || (s.attrs as GhostAttrs).reason === reason), "drop"));
}

/** Mark `target` with a Lab finding. */
export function flagText(md: string, target: string, flag: string, opts: { note?: string; occurrence?: number } = {}): string {
  needUnique(md, target, opts.occurrence);
  const range = locate(md, target, opts.occurrence ?? 1);
  return md.slice(0, range.start) + openTag("flag", { flag, note: opts.note }) + target + CLOSE_TAG + md.slice(range.end);
}

/** Remove Lab findings (all, or one kind). */
export function clearFlags(md: string, flag?: string): string {
  return rewriteSpans(md, (s) => s.kind === "flag" && (!flag || (s.attrs as FlagAttrs).flag === flag), "unwrap");
}

function rewriteSpans(md: string, match: (s: DraftSpan) => boolean, mode: "unwrap" | "drop"): string {
  let out = md;
  const spans = findDraftSpans(md).filter(match).sort((a, b) => b.start - a.start);
  for (const s of spans) {
    out = out.slice(0, s.start) + (mode === "drop" ? "" : out.slice(s.innerStart, s.innerEnd)) + out.slice(s.end);
  }
  return out;
}

/** A readable listing of every drafting span, for `cast doc drafts`. */
export function describeDrafts(md: string): Array<
  | { kind: "alts"; shown: string; at: number; versions: AltOption[] }
  | { kind: "ghost"; text: string; reason: string }
  | { kind: "flag"; text: string; flag: string; note?: string }
> {
  return findDraftSpans(md).map((s) => {
    const inner = stripDrafting(s.inner);
    if (s.kind === "alts") {
      const a = s.attrs as AltAttrs;
      return { kind: "alts" as const, shown: inner, at: Math.min(a.at, a.alts.length), versions: fullAltList(a, inner) };
    }
    if (s.kind === "ghost") return { kind: "ghost" as const, text: inner, reason: (s.attrs as GhostAttrs).reason };
    const f = s.attrs as FlagAttrs;
    return { kind: "flag" as const, text: inner, flag: f.flag, ...(f.note ? { note: f.note } : {}) };
  });
}

/** Words in text, for trim targets ("535 -> 480 words"). */
export function wordCount(text: string): number {
  return (text.match(/[A-Za-z0-9À-￿'’-]+/g) ?? []).length;
}

// ── ProseMirror JSON bridge ─────────────────────────────────────────
// The editor holds drafting spans as marks. These helpers move between those
// marks and the markdown spans for the server's converters (docSync toMarkdown,
// docs markdownToDoc), so a doc written by the CLI opens with live marks and a
// doc saved from the editor writes the same spans back.

export const DRAFT_MARKS = { alts: "draftAlts", ghost: "draftGhost", flag: "draftFlag" } as const;
const MARK_KIND: Record<string, DraftKind> = { draftAlts: "alts", draftGhost: "ghost", draftFlag: "flag" };
/** Nesting order when several drafting marks cover the same text (outermost first). */
const KIND_ORDER: DraftKind[] = ["alts", "ghost", "flag"];

interface PMMark {
  type: string;
  attrs?: Record<string, any>;
}
interface PMNode {
  type: string;
  text?: string;
  marks?: PMMark[];
  attrs?: Record<string, any>;
  content?: PMNode[];
}

export function isDraftMark(mark: { type: string }): boolean {
  return mark.type in MARK_KIND;
}

/** The opening tag for a drafting mark from editor JSON. */
export function draftMarkTag(mark: PMMark): string {
  const kind = MARK_KIND[mark.type];
  const a = mark.attrs ?? {};
  if (kind === "alts") return openTag("alts", { alts: normalizeAlts(a.alts), at: Number(a.at) || 0, ai: !!a.ai });
  if (kind === "ghost") return openTag("ghost", { reason: a.reason ?? "" });
  return openTag("flag", { flag: a.flag ?? "", note: a.note ?? undefined });
}

/**
 * Serialize a run of inline nodes, opening each drafting span once around
 * every adjacent node that carries the same mark, so a span holding bold text
 * still writes as one span. `inner` serializes a node with its drafting marks
 * already removed.
 */
export function serializeDraftRuns(nodes: PMNode[], inner: (node: PMNode) => string): string {
  let out = "";
  const open: string[] = [];
  for (const node of nodes) {
    const marks = (node.marks ?? [])
      .filter(isDraftMark)
      .sort((x, y) => KIND_ORDER.indexOf(MARK_KIND[x.type]) - KIND_ORDER.indexOf(MARK_KIND[y.type]));
    const tags = marks.map(draftMarkTag);
    let k = 0;
    while (k < open.length && k < tags.length && open[k] === tags[k]) k++;
    while (open.length > k) {
      out += CLOSE_TAG;
      open.pop();
    }
    for (let j = k; j < tags.length; j++) {
      out += tags[j];
      open.push(tags[j]);
    }
    const rest = (node.marks ?? []).filter((m) => !isDraftMark(m));
    out += inner(rest.length === (node.marks ?? []).length ? node : { ...node, marks: rest });
  }
  while (open.length) {
    out += CLOSE_TAG;
    open.pop();
  }
  return out;
}

/** The editor mark for a parsed drafting span. */
export function draftMarkFor(span: { kind: DraftKind; attrs: AltAttrs | GhostAttrs | FlagAttrs }): PMMark {
  if (span.kind === "alts") {
    const a = span.attrs as AltAttrs;
    return { type: DRAFT_MARKS.alts, attrs: { alts: a.alts, at: a.at, ai: !!a.ai } };
  }
  if (span.kind === "ghost") return { type: DRAFT_MARKS.ghost, attrs: { reason: (span.attrs as GhostAttrs).reason } };
  const f = span.attrs as FlagAttrs;
  return { type: DRAFT_MARKS.flag, attrs: { flag: f.flag, note: f.note ?? null } };
}

/**
 * Plain text that may hold drafting spans, as text nodes carrying drafting
 * marks. Everything outside the spans stays literal text, as the server's
 * markdown reader already treats it.
 */
export function draftTextNodes(text: string, marks: PMMark[] = []): PMNode[] {
  const top = findDraftSpans(text).filter((s, _, all) => !all.some((o) => o !== s && o.start <= s.start && o.end >= s.end));
  if (!top.length) return text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : [];
  const out: PMNode[] = [];
  let at = 0;
  for (const s of top) {
    if (s.start > at) out.push({ type: "text", text: text.slice(at, s.start), ...(marks.length ? { marks } : {}) });
    out.push(...draftTextNodes(s.inner, [...marks, draftMarkFor(s)]));
    at = s.end;
  }
  if (at < text.length) out.push({ type: "text", text: text.slice(at), ...(marks.length ? { marks } : {}) });
  return out;
}

// ── The Lab ─────────────────────────────────────────────────────────
// Model-assisted editing that never rewrites: every result lands as drafting
// markup the writer keeps or drops. Alternatives join the version list, trims
// ghost what could go, findings flag text, and typo fixes become a version the
// writer can cycle back from.

export const LAB_TRIMS = [
  { level: "slight", label: "Slight trim", pct: 10 },
  { level: "tighten", label: "Tighten more", pct: 20 },
  { level: "sharper", label: "Even sharper", pct: 30 },
  { level: "half", label: "Cut in half", pct: 50 },
] as const;
export type TrimLevel = (typeof LAB_TRIMS)[number]["level"];

export const LAB_FLAGS = [
  { flag: "weak", label: "Mark the weakest sentences" },
  { flag: "long", label: "Mark sentences that run long" },
  { flag: "convoluted", label: "Mark convoluted sentences" },
  { flag: "tone", label: "Mark words that don't fit the tone" },
  { flag: "filler", label: "Mark hedges and filler" },
] as const;

export type LabRequest =
  | { tool: "alternatives"; target: string; context: string }
  | { tool: "trim"; level: TrimLevel }
  | { tool: "flag"; flag: string }
  | { tool: "typos" };

export type LabResult =
  | { tool: "alternatives"; options: string[] }
  | { tool: "trim"; level: TrimLevel; cuts: string[] }
  | { tool: "flag"; flag: string; items: Array<{ text: string; note?: string }> }
  | { tool: "typos"; fixes: Array<{ old: string; new: string }> };

/** First occurrence of `text` that no drafting span already covers and that cuts through no tag. */
function locateFree(md: string, text: string, kind: DraftKind): { start: number; end: number } | null {
  if (!text) return null;
  const spans = findDraftSpans(md).filter((s) => s.kind === kind);
  for (let n = 1; ; n++) {
    let range: { start: number; end: number };
    try {
      range = locate(md, text, n);
    } catch (e) {
      if (e instanceof DraftTargetError && /cuts through/.test(e.message)) continue;
      return null;
    }
    if (!spans.some((s) => s.innerStart < range.end && s.innerEnd > range.start)) return range;
  }
}

function wrapAt(md: string, range: { start: number; end: number }, open: string): string {
  return md.slice(0, range.start) + open + md.slice(range.start, range.end) + CLOSE_TAG + md.slice(range.end);
}

/**
 * Land a Lab result in markdown. A new trim replaces the previous trim's
 * proposals, so stepping between levels never stacks them. Returns how many
 * findings landed and which could not be found in the text.
 */
export function applyLabResult(
  md: string,
  result: LabResult,
  opts: { target?: string; occurrence?: number } = {},
): { md: string; applied: number; missed: string[] } {
  const missed: string[] = [];
  let applied = 0;
  let out = md;
  if (result.tool === "alternatives") {
    if (!opts.target) throw new DraftTargetError("Alternatives need the text they are for");
    out = addAlternatives(out, opts.target, result.options, { ai: true, occurrence: opts.occurrence });
    return { md: out, applied: result.options.length, missed };
  }
  if (result.tool === "trim") {
    out = reviveText(out, undefined, { reason: TRIM_REASON });
    for (const cut of result.cuts) {
      const range = locateFree(out, cut, "ghost");
      if (!range) { missed.push(cut); continue; }
      out = wrapAt(out, range, openTag("ghost", { reason: TRIM_REASON }));
      applied++;
    }
    return { md: out, applied, missed };
  }
  if (result.tool === "flag") {
    out = clearFlags(out, result.flag);
    for (const item of result.items) {
      const range = locateFree(out, item.text, "flag");
      if (!range) { missed.push(item.text); continue; }
      out = wrapAt(out, range, openTag("flag", { flag: result.flag, note: item.note }));
      applied++;
    }
    return { md: out, applied, missed };
  }
  for (const fix of result.fixes) {
    const range = fix.old && fix.old !== fix.new ? locateFree(out, fix.old, "alts") : null;
    if (!range) { missed.push(fix.old); continue; }
    const { attrs, shown } = altAttrsFor([{ t: fix.old }, { t: fix.new, ai: true }], 1);
    out = out.slice(0, range.start) + openTag("alts", attrs) + shown + CLOSE_TAG + out.slice(range.end);
    applied++;
  }
  return { md: out, applied, missed };
}
