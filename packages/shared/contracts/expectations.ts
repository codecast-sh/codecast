// A project's expectations (docs/architecture/the-line-model.md LM5): how the
// project should behave, each line stated plainly with the sources it came
// from. A judge compares what happened with the active lines and cites the id
// a finding breaks, together with the version it graded against.
//
// The document changes only through a proposal: additions, edits and
// retirements, each carrying its sources. Applying one writes a new version
// and keeps every earlier one. This module is the pure half: the shapes, the
// proposal parser (JSON or markdown), the rule that lets a proposal apply on
// its own, applying a proposal to a set of lines, and the renderings the CLI,
// a judge and a card read. Server: convex/expectations.ts.

// "person": a person's own words, typed where the expectations are read
// (the Line tab, the map's panel); its ref is their user id.
export const CITATION_KINDS = ["call", "chat", "session", "task", "decision", "commit", "file", "doc", "desk", "call_grade", "signal", "person", "other"] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];

export type ExpectationCitation = {
  kind: CitationKind;
  /** Where to find it, one word: cl-96:58, ct-50164, sd-346, #team/<message id>, repo@sha, a path, a person's user id. */
  ref: string;
  /** The words behind the line, verbatim. */
  quote?: string;
  /** When it was said or written, an ISO day or time. */
  when?: string;
};

export type ExpectationStatus = "active" | "retired";

export type Expectation = {
  /** Stable for the life of the document: ex-<prefix>-<n>. */
  id: string;
  /** The expected behavior, one sentence. */
  text: string;
  /** The part of the system it concerns. */
  part: string;
  status: ExpectationStatus;
  /** An open question about the line (contested, under review). */
  note?: string;
  citations: ExpectationCitation[];
  /** Why it was retired; set with status "retired". */
  retired_reason?: string;
  /** The version that added it, and the last version that changed it. */
  added_in: number;
  changed_in: number;
};

export type AddOp = { op: "add"; text: string; part: string; note?: string; citations: ExpectationCitation[]; status?: ExpectationStatus; reason?: string };
export type EditOp = { op: "edit"; id: string; text?: string; part?: string; note?: string; citations: ExpectationCitation[] };
export type RetireOp = { op: "retire"; id: string; reason: string; citations: ExpectationCitation[] };
export type ExpectationOp = AddOp | EditOp | RetireOp;

export type ExpectationProposalInput = {
  summary: string;
  /** The window of team context the proposal was read from (ms); the next harvest starts at `until`. */
  since?: number;
  until?: number;
  ops: ExpectationOp[];
};

/** One version of a project's document, as the server returns it. */
export type ExpectationsVersion = {
  project: { id: string; title: string };
  version: number;
  prefix: string;
  /** The number the next added line takes (ex-<prefix>-<next_n>). */
  next_n?: number;
  items: Expectation[];
  applied_at: number;
  applied_by?: string;
  how: "person" | "auto";
  summary: string;
  proposal?: string;
};

export const LIMITS = { text: 400, part: 80, note: 400, reason: 400, ref: 200, quote: 600, when: 40, summary: 300, citations: 20, ops: 120 } as const;

const clip = (s: unknown, max: number): string => (typeof s === "string" ? s.trim().slice(0, max) : "");

function normCitation(raw: any): ExpectationCitation {
  const out: ExpectationCitation = { kind: clip(raw?.kind, 20).toLowerCase() as CitationKind, ref: clip(raw?.ref, LIMITS.ref) };
  const quote = clip(raw?.quote, LIMITS.quote).replace(/^["“]|["”]$/g, "").trim();
  const when = clip(raw?.when, LIMITS.when);
  if (quote) out.quote = quote;
  if (when) out.when = when;
  return out;
}

/** A proposal's fields trimmed and bounded, unknown fields dropped. */
export function normalizeOp(raw: any): ExpectationOp {
  const citations = Array.isArray(raw?.citations) ? raw.citations.map(normCitation) : [];
  const op = clip(raw?.op, 10).toLowerCase();
  if (op === "add") {
    const out: AddOp = { op: "add", text: clip(raw.text, LIMITS.text), part: clip(raw.part, LIMITS.part), citations };
    if (clip(raw.note, LIMITS.note)) out.note = clip(raw.note, LIMITS.note);
    if (raw.status === "retired") { out.status = "retired"; out.reason = clip(raw.reason, LIMITS.reason); }
    return out;
  }
  if (op === "edit") {
    const out: EditOp = { op: "edit", id: clip(raw.id, 80), citations };
    for (const key of ["text", "part", "note"] as const) if (typeof raw[key] === "string") out[key] = clip(raw[key], LIMITS[key]);
    return out;
  }
  return { op: op as "retire", id: clip(raw?.id, 80), reason: clip(raw?.reason, LIMITS.reason), citations };
}

/** What is wrong with one op, as short sentences; empty when it can apply. */
export function opErrors(op: ExpectationOp): string[] {
  const errors: string[] = [];
  if (!["add", "edit", "retire"].includes(op.op)) return [`unknown op "${op.op}" (add, edit or retire)`];
  if (op.citations.length === 0) errors.push("needs at least one source");
  op.citations.forEach((c, i) => {
    if (!CITATION_KINDS.includes(c.kind)) errors.push(`source ${i + 1}: kind "${c.kind}" is not one of ${CITATION_KINDS.join(", ")}`);
    if (!c.ref) errors.push(`source ${i + 1}: needs a ref`);
  });
  if (op.op === "add") {
    if (!op.text) errors.push("needs the expected behavior (text)");
    if (!op.part) errors.push("needs the part of the system (part)");
    if (op.status === "retired" && !op.reason) errors.push("a retired line needs the reason");
  } else {
    if (!isExpectationId(op.id)) errors.push(`"${op.id}" is not an expectation id (ex-<project>-<n>)`);
    if (op.op === "edit" && op.text === undefined && op.part === undefined && op.note === undefined) errors.push("changes nothing (text, part or note)");
    if (op.op === "edit" && op.text === "") errors.push("an edit cannot empty the text; retire the line instead");
    if (op.op === "retire" && !op.reason) errors.push("needs the reason");
  }
  return errors;
}

/** A source a reader can trace to the words: a quote, and when it was said. */
export const isQuotedAndDated = (c: ExpectationCitation): boolean => (c.quote?.length ?? 0) >= 8 && !!c.when;

/**
 * The kinds whose quote can be a person's own words, checked against the
 * record: a line a person typed in team chat, a decision a person answered, a
 * person speaking on a call, or a line a signed-in person typed on the web
 * (the server holds that one only for the person who sent it). Every other kind (a task note, a commit, a
 * session) can carry an agent's account of what shipped, so it never lets a
 * line in without a person.
 */
export const PERSON_SOURCE_KINDS: readonly CitationKind[] = ["call", "chat", "decision", "person"];

// Words that carry no claim: a line and a quote that share only these say nothing about each other.
const FILLER = new Set("about after again against also always another anything because been before being between both cannot could does done each even every everything from going have here into itself just know like made make makes more most must need needs never okay only onto other over really same shall should some something still such sure than that their them then there these they thing things think this those under unless until very want wants were what when where which while will with would yeah your".split(" "));

/** The words of a sentence that carry its claim: four letters or more, no filler. */
function claimWords(s: string): string[] {
  return [...new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !FILLER.has(w)))];
}

/** Two forms of one word (track, tracked; bounce, bouncing): the shorter, less its last letter, opens the longer. */
function sameWord(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short.slice(0, Math.max(4, short.length - 1)));
}

/** How many claim words a line must share with a quote before the quote can stand behind it. */
export const SHARED_WORDS_NEEDED = 2;

/**
 * Whether a line is about what its quote says: they share at least two claim
 * words. This is a floor, not proof. It stops a line from riding in on an
 * unrelated quote ("No, leave it" behind a rule about bounces), and it cannot
 * tell a faithful line from one that reuses the quote's words to say something
 * else; a line that fails it goes to the project's person, who reads both.
 */
export function followsFromQuote(text: string, quote: string): boolean {
  const said = claimWords(quote);
  return claimWords(text).filter((w) => said.some((q) => sameWord(w, q))).length >= SHARED_WORDS_NEEDED;
}

/** The sources of an addition that could let it in without a person: quoted, dated, a kind a person speaks in, and about what the line says. */
export function groundingCandidates(op: AddOp): ExpectationCitation[] {
  return op.citations.filter((c) => isQuotedAndDated(c) && PERSON_SOURCE_KINDS.includes(c.kind) && followsFromQuote(op.text, c.quote!));
}

/**
 * A proposal applies without a person (LM5) when it only adds lines and each
 * line carries a quoted, dated source that the record shows a person said
 * (`personSaid`, checked by the server against the chat line, the decision or
 * the call segment the citation names) and that the line is about
 * (`followsFromQuote`). It changes no line anyone graded against, and every
 * line it adds stands on a person's words. A line added already retired is
 * history (a rule the team has moved past), so it adds on the same terms.
 * Anything that edits or retires a line, or adds one whose words cannot be
 * traced to a person, waits for the project's person.
 */
export function autoApplies(ops: ExpectationOp[], personSaid: (c: ExpectationCitation) => boolean): boolean {
  return ops.length > 0 && ops.every((op) => op.op === "add" && groundingCandidates(op).some(personSaid));
}

/**
 * What a signed-in person changes by hand where the expectations are read
 * (line-map.md LX3, LX5): a line in their own words, or a retirement with the
 * reason. Either becomes a proposal like any other.
 */
export type PersonEdit = { op: "add"; text: string; part: string } | { op: "retire"; id: string; reason: string };

/** The op a person's edit becomes: their own words are its source, cited as them on the day they typed them. */
export function personOp(edit: PersonEdit, userId: string, now: number): ExpectationOp {
  const when = new Date(now).toISOString().slice(0, 10);
  const words = edit.op === "add" ? edit.text : edit.reason;
  return normalizeOp({ ...edit, citations: [{ kind: "person", ref: userId, quote: words, when }] });
}

/**
 * Whether a person's edit lands as they make it (LM5): the project's person
 * decides every change, so theirs applies; anyone else's applies on the rule
 * above (a line in their own words that the words stand behind), and the rest
 * waits for the project's person. The web paints from this and the server
 * applies by it, so both say the same thing.
 */
export function personEditApplies(op: ExpectationOp, isProjectPerson: boolean): boolean {
  return isProjectPerson || autoApplies([op], (c) => c.kind === "person");
}

/** A quote's words, for checking that a record holds them: lowercase words only; an ellipsis splits it into pieces that must each appear. */
export function quotePieces(quote: string): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return quote.split(/\.\.\.|\u2026/).map(norm).filter((p) => p.length > 0);
}

/** Whether `text` holds the quote, compared word for word. */
export function holdsQuote(text: string, quote: string): boolean {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const pieces = quotePieces(quote);
  return pieces.length > 0 && pieces.every((p) => hay.includes(` ${p} `));
}

const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The lines after a proposal, or why it cannot apply. `baseVersion` is the
 * version the proposal was written against: an edit or a retirement of a
 * line that changed after it is refused, so a person never applies a change
 * to words they did not see.
 */
export function applyOps(
  state: { items: Expectation[]; prefix: string; next_n: number },
  ops: ExpectationOp[],
  version: number,
  baseVersion: number,
): { ok: true; items: Expectation[]; next_n: number } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const items = state.items.map((e) => ({ ...e, citations: [...e.citations] }));
  const byId = new Map(items.map((e) => [e.id, e]));
  let next = state.next_n;
  const keep = (cs: ExpectationCitation[]) => cs.slice(-LIMITS.citations);
  ops.forEach((op, i) => {
    const at = `op ${i + 1} (${op.op}${op.op === "add" ? "" : ` ${op.id}`})`;
    const own = opErrors(op);
    if (own.length) { errors.push(...own.map((e) => `${at}: ${e}`)); return; }
    if (op.op === "add") {
      const twin = items.find((e) => e.status === "active" && normText(e.text) === normText(op.text));
      if (twin) { errors.push(`${at}: already expected as ${twin.id}`); return; }
      const line: Expectation = { id: `ex-${state.prefix}-${next++}`, text: op.text, part: op.part, status: op.status ?? "active", citations: keep(op.citations), added_in: version, changed_in: version };
      if (op.note) line.note = op.note;
      if (op.status === "retired") line.retired_reason = op.reason;
      items.push(line);
      byId.set(line.id, line);
      return;
    }
    const line = byId.get(op.id);
    if (!line) { errors.push(`${at}: no such expectation`); return; }
    if (line.changed_in > baseVersion) { errors.push(`${at}: changed in version ${line.changed_in}, after the version ${baseVersion} this proposal read; propose again from the current version`); return; }
    if (line.status === "retired") { errors.push(`${at}: already retired`); return; }
    if (op.op === "edit") {
      if (op.text !== undefined) line.text = op.text;
      if (op.part !== undefined && op.part) line.part = op.part;
      if (op.note !== undefined) { if (op.note) line.note = op.note; else delete line.note; }
    } else {
      line.status = "retired";
      line.retired_reason = op.reason;
    }
    line.citations = keep([...line.citations, ...op.citations]);
    line.changed_in = version;
  });
  return errors.length ? { ok: false, errors } : { ok: true, items, next_n: next };
}

/** Is this a line's id, `ex-<prefix>-<n>`? The form a finding cites (LM5) and a signal carries as its subject. */
export const isExpectationId = (value: string | null | undefined): value is string => !!value && /^ex-[a-z0-9-]+-\d+$/.test(value);

/** The prefix inside a line's id, which names its project within a workspace. */
export const expectationIdPrefix = (id: string): string => id.replace(/^ex-/, "").replace(/-\d+$/, "");

/** The id prefix a project's lines carry: its title's first two words. */
export function expectationPrefix(title: string): string {
  const stop = new Set(["and", "the", "of", "a", "an", "for"]);
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !stop.has(w));
  return words.slice(0, 2).join("-") || "project";
}

function parseTime(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const s = raw.trim();
  const n = /^\d{10,}$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(n)) throw new Error(`"${s}" is not a time (ISO, or epoch ms)`);
  return n;
}

const CITE_LINE = /^- ([a-z_]+) (\S+)(?: \(([^)]+)\))?(?::\s*(.+))?$/;
const OP_HEAD = /^## (add|edit|retire)(?: (\S+))?\s*$/i;
const FIELD = /^([a-z_]+):\s*(.*)$/;

/**
 * A proposal from a file: JSON ({summary, since?, until?, ops}) or markdown.
 * The markdown form: a `# summary` line, optional `since:` and `until:`
 * lines, then one `## add`, `## edit <id>` or `## retire <id>` section per
 * change, each with `field: value` lines (text, part, note, reason, status)
 * and one `- <kind> <ref> (<when>): "<quote>"` line per source. A ref is one
 * word: a chat message is `#channel/<message id>`.
 * Throws one message naming every line it could not read.
 */
export function parseProposal(input: string): ExpectationProposalInput {
  const text = input.trim();
  if (!text) throw new Error("The proposal is empty");
  let raw: any;
  if (text.startsWith("{")) {
    try { raw = JSON.parse(text); } catch (err) { throw new Error(`The proposal is not valid JSON: ${(err as Error).message}`); }
  } else {
    raw = { ops: [] as any[] };
    const errors: string[] = [];
    let current: any = null;
    text.split("\n").forEach((line, i) => {
      const l = line.trim();
      if (!l) return;
      const head = l.match(OP_HEAD);
      if (head) { current = { op: head[1].toLowerCase(), ...(head[2] ? { id: head[2] } : {}), citations: [] }; raw.ops.push(current); return; }
      if (!current && /^# /.test(l)) { raw.summary = l.slice(2).trim(); return; }
      const cite = l.match(CITE_LINE);
      if (cite && current) { current.citations.push({ kind: cite[1], ref: cite[2], when: cite[3], quote: cite[4] }); return; }
      const field = l.match(FIELD);
      if (field && !current && (field[1] === "since" || field[1] === "until" || field[1] === "summary")) { raw[field[1]] = field[2]; return; }
      if (field && current && ["text", "part", "note", "reason", "status"].includes(field[1])) { current[field[1]] = field[2]; return; }
      errors.push(`line ${i + 1}: cannot read "${l.slice(0, 80)}"`);
    });
    if (errors.length) throw new Error(`The proposal has lines it cannot read:\n${errors.join("\n")}`);
  }
  if (!Array.isArray(raw?.ops)) throw new Error("The proposal needs an ops list");
  if (raw.ops.length > LIMITS.ops) throw new Error(`At most ${LIMITS.ops} changes in one proposal`);
  const ops = raw.ops.map(normalizeOp);
  const errors = ops.flatMap((op: ExpectationOp, i: number) => opErrors(op).map((e) => `op ${i + 1} (${op.op}${op.op === "add" ? "" : ` ${op.id}`}): ${e}`));
  if (errors.length) throw new Error(`The proposal cannot apply:\n${errors.join("\n")}`);
  const out: ExpectationProposalInput = { summary: clip(raw.summary, LIMITS.summary) || `${ops.length} change${ops.length === 1 ? "" : "s"}`, ops };
  const since = parseTime(raw.since);
  const until = parseTime(raw.until);
  if (since !== undefined) out.since = since;
  if (until !== undefined) out.until = until;
  return out;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function citationLine(c: ExpectationCitation): string {
  return `${c.kind} ${c.ref}${c.when ? ` (${c.when})` : ""}${c.quote ? `: "${c.quote}"` : ""}`;
}

function byPart(items: Expectation[]): Map<string, Expectation[]> {
  const parts = new Map<string, Expectation[]>();
  for (const e of items) parts.set(e.part, [...(parts.get(e.part) ?? []), e]);
  return parts;
}

/**
 * The document as text. `brief` is what a judge reads: the active lines with
 * their ids and notes, grouped by part, under the version to cite. The full
 * form adds every line's sources and the retired lines with their reasons.
 */
export function renderExpectations(doc: ExpectationsVersion, opts: { brief?: boolean } = {}): string {
  const active = doc.items.filter((e) => e.status === "active");
  const retired = doc.items.filter((e) => e.status === "retired");
  const out: string[] = [
    `Expectations for ${doc.project.title}, version ${doc.version} (${day(doc.applied_at)}).`,
    `Grade against the active lines below. A finding names the id it breaks and version ${doc.version}.`,
  ];
  for (const [part, lines] of byPart(active)) {
    out.push("", `## ${part}`);
    for (const e of lines) {
      out.push(`${e.id}: ${e.text}`);
      if (e.note) out.push(`  note: ${e.note}`);
      if (!opts.brief) for (const c of e.citations) out.push(`  - ${citationLine(c)}`);
    }
  }
  if (!opts.brief && retired.length) {
    out.push("", "## Retired (never graded against)");
    for (const e of retired) {
      out.push(`${e.id}: ${e.text}`, `  retired in version ${e.changed_in}: ${e.retired_reason ?? ""}`);
      for (const c of e.citations) out.push(`  - ${citationLine(c)}`);
    }
  }
  return out.join("\n") + "\n";
}

/** A proposal as a person reads it before applying: each change with its sources, edits shown against the current words. */
export function renderProposal(p: { summary: string; ops: ExpectationOp[] }, current: Expectation[]): string {
  const byId = new Map(current.map((e) => [e.id, e]));
  const out: string[] = [p.summary];
  for (const op of p.ops) {
    out.push("");
    if (op.op === "add") {
      out.push(`**Add${op.status === "retired" ? " as retired" : ""}** (${op.part}): ${op.text}`);
      if (op.note) out.push(`Note: ${op.note}`);
      if (op.status === "retired") out.push(`Retired because: ${op.reason}`);
    } else if (op.op === "edit") {
      const was = byId.get(op.id);
      out.push(`**Change ${op.id}**${op.part ? ` (part: ${op.part})` : ""}`);
      if (op.text !== undefined) out.push(`Was: ${was?.text ?? "(unknown line)"}`, `Now: ${op.text}`);
      if (op.note !== undefined) out.push(op.note ? `Note: ${op.note}` : "Note removed");
    } else {
      out.push(`**Retire ${op.id}**: ${byId.get(op.id)?.text ?? "(unknown line)"}`, `Because: ${op.reason}`);
    }
    for (const c of op.citations) out.push(`- ${citationLine(c)}`);
  }
  return out.join("\n");
}
