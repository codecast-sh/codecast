// A step's prompt as the workspace reads it (line-workspace.md LW3): an
// outline of sections, each folded to its first sentence (Studio's prompt
// view), the shared sections it pulls in folded where they sit, and a diff of
// two texts with the unchanged stretches folded. Pure, so the prompt widget,
// the diff widget and any view count lines the same way.
import { diffLines } from "diff";

/** A line that is one shared section on its own: "$shared.json.rulings". */
const INCLUDE_LINE = /^\s*\$(shared\w*)\.json\.(\w+)\s*$/;

export type PromptSection = {
  /** The heading's words; the text before the first heading is the step's "Role". */
  title: string;
  /** Its first sentence, plain, for the folded row. */
  lead: string;
  body: string;
  /** Line numbers in the whole text: the body's first line, and one past its last. */
  start: number;
  end: number;
  words: number;
};

export type PromptPart = { kind: "text"; text: string } | { kind: "include"; name: string; from: string };

/** Markup and inserted values said plainly, for a one-line lead. */
const plainLead = (s: string) =>
  s.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\$[a-z_]+(?:\.[a-z_]+)*/gi, (m) => m.slice(1).split(".").pop()!.replace(/_/g, " "));

/** What a section hands the step past its opening list, named in its lead: a step that reads the cause's earlier attempts says so. */
const SECTION_EXTRAS: ReadonlyArray<[RegExp, string]> = [[/\$cause_history\b/, "its earlier attempts"]];

/** A section that opens with a list of facts ("- Cause task: $task_id") leads with what the list names, never its placeholders:
 *  "Cause task, cluster, judge and 2 more"; `extra` names what the section hands on after the list ("its earlier attempts"), always shown. */
function listLead(block: string, extra: ReadonlyArray<string> = []): string | null {
  // An item wrapped onto an indented line continues that item.
  const items: string[] = [];
  for (const raw of block.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/^\s/.test(raw) && items.length && !/^([-*]|\d+\.)\s+/.test(l)) items[items.length - 1] += ` ${l}`;
    else items.push(l);
  }
  if (items.length < 2 || !items.every((l) => /^([-*]|\d+\.)\s+/.test(l))) return null;
  const names = items.map((l) => {
    const t = plainLead(l.replace(/^([-*]|\d+\.)\s+/, ""));
    const label = t.includes(":") ? t.slice(0, t.indexOf(":")) : t.split(/\s+/).slice(0, 4).join(" ");
    return label.replace(/[()]/g, "").trim();
  }).filter(Boolean).map((n, i) => (i ? n.charAt(0).toLowerCase() + n.slice(1) : n));
  if (names.length < 2) return null;
  const shown = names.length + extra.length <= 4 ? [...names, ...extra] : [...names.slice(0, Math.max(1, 3 - extra.length)), ...extra];
  const more = names.length + extra.length - shown.length;
  return more ? `${shown.join(", ")} and ${more} more` : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** The prompt's sections, split at its `##` headings. Sections with nothing in them drop out. */
export function promptSections(text: string): PromptSection[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const heads: number[] = [];
  lines.forEach((l, i) => { if (/^##\s+/.test(l)) heads.push(i); });
  const cuts = [0, ...heads.filter((h) => h > 0), lines.length];
  const out: PromptSection[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const isHead = /^##\s+/.test(lines[a] ?? "");
    const start = isHead ? a + 1 : a;
    const body = lines.slice(start, b).join("\n");
    if (!body.trim()) continue;
    const block = body.trim().split(/\n\s*\n/)[0] ?? "";
    const first = block.replace(/\n/g, " ").replace(INCLUDE_LINE, "").trim();
    const extra = SECTION_EXTRAS.filter(([re]) => re.test(body) && !re.test(block)).map(([, words]) => words);
    const sentence = listLead(block, extra) ?? plainLead(first).split(/(?<=[.?!])\s/)[0] ?? "";
    out.push({
      title: isHead ? lines[a].replace(/^#+\s+/, "").trim() : "Role",
      lead: sentence.length > 140 ? `${sentence.slice(0, 138).replace(/\s+\S*$/, "")}…` : sentence,
      body,
      start,
      end: b,
      words: body.split(/\s+/).filter(Boolean).length,
    });
  }
  return out;
}

/** A text cut where a shared section sits on its own line, so each folds in place. */
export function promptParts(text: string): PromptPart[] {
  const out: PromptPart[] = [];
  let buf: string[] = [];
  const flush = () => { if (buf.join("\n").trim()) out.push({ kind: "text", text: buf.join("\n") }); buf = []; };
  for (const line of text.split("\n")) {
    const m = INCLUDE_LINE.exec(line);
    if (m) { flush(); out.push({ kind: "include", name: m[2], from: m[1] }); }
    else buf.push(line);
  }
  flush();
  return out;
}

/** diffLines reads a last line without its newline as a different line; both texts end in one here. */
const ended = (t: string) => (t.endsWith("\n") ? t : `${t}\n`);
const diffParts = (before: string, after: string) => diffLines(ended(before.replace(/\r/g, "")), ended(after.replace(/\r/g, "")));

export type DiffRow = { op: "add" | "del" | "ctx"; text: string } | { op: "gap"; count: number; from: number };
export type PromptDiffResult = { rows: DiffRow[]; added: number; removed: number; changedAfter: Set<number> };

/**
 * Two texts compared line by line. Unchanged stretches longer than twice
 * `context` fold into one gap row that names how many lines it holds;
 * `changedAfter` holds the new text's line numbers that were added, so an
 * outline can mark the sections an edit touched.
 */
export function promptDiff(before: string, after: string, context = 2): PromptDiffResult {
  const flat: Array<{ op: "add" | "del" | "ctx"; text: string }> = [];
  const changedAfter = new Set<number>();
  let afterLine = 0;
  let added = 0;
  let removed = 0;
  for (const part of diffParts(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (part.added) { flat.push({ op: "add", text }); changedAfter.add(afterLine++); added++; }
      else if (part.removed) { flat.push({ op: "del", text }); removed++; }
      else { flat.push({ op: "ctx", text }); afterLine++; }
    }
  }
  const keep = new Set<number>();
  flat.forEach((r, i) => { if (r.op !== "ctx") for (let k = i - context; k <= i + context; k++) keep.add(k); });
  const rows: DiffRow[] = [];
  let gap = 0;
  let gapFrom = 0;
  flat.forEach((r, i) => {
    if (keep.has(i)) {
      if (gap) { rows.push({ op: "gap", count: gap, from: gapFrom }); gap = 0; }
      rows.push(r);
    } else {
      if (!gap) gapFrom = i;
      gap++;
    }
  });
  if (gap) rows.push({ op: "gap", count: gap, from: gapFrom });
  return { rows, added, removed, changedAfter };
}

/** The unfolded rows of a gap, for a reader who opens it. */
export function diffGapRows(before: string, after: string, from: number, count: number): DiffRow[] {
  const flat: DiffRow[] = [];
  for (const part of diffParts(before, after)) {
    for (const text of part.value.replace(/\n$/, "").split("\n")) flat.push({ op: part.added ? "add" : part.removed ? "del" : "ctx", text });
  }
  return flat.slice(from, from + count);
}
