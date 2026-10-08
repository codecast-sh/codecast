// The change guide (ct-57527): the author's walkthrough of a change, written
// at handoff by the session that made it. Each step names a file and a line
// range and says why that piece exists, in the order that explains the change
// best; the focused hunk is captured with it so the guide survives later edits.
// One guide feeds the task's review station, the pull request description and
// the Changes stories.
//
// The author writes light markdown: a heading per step with the location on the
// heading line, the reason under it. Text before the first step is the summary.
//
//   Add the parser first, everything reads it.
//
//   ## Parse the guide `packages/shared/contracts/changeGuide.ts:40-120`
//   One function turns the markdown into steps...
//
//   ## Store it on the task `packages/convex/convex/schema.ts:5775`
//   ...
//
// A heading without a location is prose inside the step above it (or the
// summary, before the first step), so an author can still use subheadings.

export interface ChangeGuideStep {
  title: string;
  /** The author's reason for this piece, markdown. */
  why: string;
  file: string;
  /** New-side line range; absent means the whole file's diff. */
  start?: number;
  end?: number;
  /** Unified diff hunks for the range, captured at handoff. */
  hunk?: string;
  /** The hunk was cut to fit MAX_STEP_HUNK_LINES. */
  truncated?: boolean;
}

export interface ChangeGuide {
  summary?: string;
  steps: ChangeGuideStep[];
}

/** Lines of diff kept per step: enough for a focused hunk, bounded so a new file can't bloat the task row. */
export const MAX_STEP_HUNK_LINES = 160;
/** Context kept around the named range when a hunk is focused to it. */
const RANGE_CONTEXT = 3;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
// A location: a path with a dot or a slash in it, then an optional :start or :start-end (L-prefixes allowed).
// Brackets are path characters, for route files (`app/task/[id].tsx`).
const LOCATION_BODY = String.raw`((?:[\w@.~[\]-]+\/)*[\w@.~[\]-]+\.[\w-]+|(?:[\w@.~[\]-]+\/)+[\w@.~[\]-]+)(?::L?(\d+)(?:\s*[-–]\s*L?(\d+))?)?`;
const LOCATION_TICKED = new RegExp("`" + LOCATION_BODY + "`");
const LOCATION_BARE = new RegExp(String.raw`(?:^|[\s(])` + LOCATION_BODY + String.raw`(?=$|[\s),])`);

/** The step's location on a heading line, and the title with it taken out. */
export function parseStepHeading(text: string): { title: string; file: string; start?: number; end?: number } | null {
  const ticked = text.match(LOCATION_TICKED);
  const m = ticked ?? text.match(LOCATION_BARE);
  // Outside backticks a bare word with a dot ("e.g.") is prose: it needs a slash or a line number to count.
  if (!m || (!ticked && !m[2] && !m[1].includes("/"))) return null;
  const file = m[1].replace(/^\.\//, "");
  const start = m[2] ? Number(m[2]) : undefined;
  const end = m[3] ? Number(m[3]) : start;
  const title = text
    .replace(m[0].replace(/^[\s(]/, ""), " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s*[-–—·:|]\s*$/, "")
    .replace(/^\s*[-–—·:|]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title || file, file, ...(start !== undefined ? { start, end: Math.max(start, end ?? start) } : {}) };
}

type Hunk = { oldStart: number; newStart: number; lines: string[] };

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of patch.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      cur = { oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] };
      hunks.push(cur);
    } else if (cur && /^[ +\-\\]/.test(line)) {
      cur.lines.push(line);
    } else if (cur && line === "") {
      // A blank context line some tools emit without its leading space.
      cur.lines.push(" ");
    }
  }
  // A trailing "" from the final newline is not a context line.
  for (const h of hunks) while (h.lines.length && h.lines[h.lines.length - 1] === " ") h.lines.pop();
  return hunks;
}

function formatHunk(oldStart: number, newStart: number, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === " " || l[0] === "-").length;
  const newCount = lines.filter((l) => l[0] === " " || l[0] === "+").length;
  return [`@@ -${oldCount ? oldStart : Math.max(0, oldStart - 1)},${oldCount} +${newCount ? newStart : Math.max(0, newStart - 1)},${newCount} @@`, ...lines].join("\n");
}

/**
 * The hunks of one file's unified diff that touch new-side lines start..end,
 * each cut down to that range plus a little context, so a step shows its own
 * lines and not the whole file. No range keeps every hunk. Capped at
 * MAX_STEP_HUNK_LINES diff lines.
 *
 * `neighbors` are the other steps' ranges in the same file: context stops at
 * the line before one, so two steps never repeat each other's code (ranges one
 * line apart share just the line between them).
 */
export function focusHunks(patch: string, start?: number, end?: number, neighbors: ReadonlyArray<{ start: number; end: number }> = []): { hunk: string; truncated: boolean } | null {
  let lo = start === undefined ? -Infinity : start - RANGE_CONTEXT;
  let hi = end === undefined ? Infinity : end + RANGE_CONTEXT;
  if (start !== undefined && end !== undefined) {
    for (const n of neighbors) {
      if (n.end < start) lo = Math.max(lo, n.end + 1);
      if (n.start > end) hi = Math.min(hi, n.start - 1);
    }
  }
  const out: string[] = [];
  let budget = MAX_STEP_HUNK_LINES;
  let truncated = false;
  for (const h of parseHunks(patch)) {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    let kept: string[] = [];
    let keptOld = 0;
    let keptNew = 0;
    for (const line of h.lines) {
      const kind = line[0];
      if (kind === "\\") {
        if (kept.length) kept.push(line);
        continue;
      }
      // A removed line sits where the new text continues, so it is in range when that point is.
      if (newLine >= lo && newLine <= hi) {
        if (!kept.length) { keptOld = oldLine; keptNew = newLine; }
        kept.push(line);
      }
      if (kind !== "+") oldLine++;
      if (kind !== "-") newLine++;
    }
    if (!kept.some((l) => l[0] === "+" || l[0] === "-")) continue;
    if (budget <= 0) { truncated = true; break; }
    if (kept.length > budget) { kept = kept.slice(0, budget); truncated = true; }
    budget -= kept.length;
    out.push(formatHunk(keptOld, keptNew, kept));
  }
  return out.length ? { hunk: out.join("\n"), truncated } : null;
}

/**
 * Turn the author's guide markdown into steps, attaching each step's focused
 * hunk from `diffFor(file)` (the file's unified diff, or null when it has
 * none). Throws when the text holds no step heading, naming the form it wants.
 */
export function parseChangeGuide(markdown: string, diffFor?: (file: string) => string | null): ChangeGuide {
  const summary: string[] = [];
  const steps: Array<ChangeGuideStep & { body: string[] }> = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(HEADING);
    const located = heading ? parseStepHeading(heading[2]) : null;
    if (located) {
      steps.push({ ...located, why: "", body: [] });
      continue;
    }
    (steps.length ? steps[steps.length - 1].body : summary).push(line);
  }
  if (!steps.length) {
    throw new Error("the guide needs a heading per step with its location on the heading line, e.g. ## Parse the guide `src/guide.ts:40-120`");
  }
  const diffs = new Map<string, string | null>();
  const ranged = steps.filter((s) => s.start !== undefined && s.end !== undefined) as Array<{ file: string; start: number; end: number }>;
  const result: ChangeGuide = {
    steps: steps.map(({ body, ...step }) => {
      const out: ChangeGuideStep = { ...step, why: body.join("\n").trim() };
      if (diffFor) {
        if (!diffs.has(step.file)) diffs.set(step.file, diffFor(step.file));
        const patch = diffs.get(step.file);
        const neighbors = ranged.filter((o) => o.file === step.file && !(o.start === step.start && o.end === step.end));
        const focused = patch ? focusHunks(patch, step.start, step.end, neighbors) : null;
        if (focused) {
          out.hunk = focused.hunk;
          if (focused.truncated) out.truncated = true;
        }
      }
      return out;
    }),
  };
  const intro = summary.join("\n").trim();
  if (intro) result.summary = intro;
  return result;
}

/** `path:12-40`, `path:12` or `path`. */
export function stepLocation(step: Pick<ChangeGuideStep, "file" | "start" | "end">): string {
  if (step.start === undefined) return step.file;
  return step.end !== undefined && step.end !== step.start ? `${step.file}:${step.start}-${step.end}` : `${step.file}:${step.start}`;
}

/** GitHub caps a PR body at 65536 characters; past this budget the hunks are left out. */
const MARKDOWN_HUNK_BUDGET = 48_000;

/**
 * The guide as markdown for a pull request body: the summary, then a numbered
 * step per heading with its location, reason and hunk. `hunks: false` (or a
 * guide whose hunks would not fit) leaves the code out.
 */
export function changeGuideMarkdown(guide: ChangeGuide, opts: { heading?: string; hunks?: boolean } = {}): string {
  const withHunks = (opts.hunks ?? true) && guide.steps.reduce((n, s) => n + (s.hunk?.length ?? 0), 0) <= MARKDOWN_HUNK_BUDGET;
  const parts: string[] = [];
  if (opts.heading) parts.push(opts.heading);
  if (guide.summary) parts.push(guide.summary);
  guide.steps.forEach((s, i) => {
    parts.push(`### ${i + 1}. ${s.title}\n\`${stepLocation(s)}\``);
    if (s.why) parts.push(s.why);
    if (withHunks && s.hunk) parts.push("```diff\n" + s.hunk + "\n```");
  });
  return parts.join("\n\n");
}

/** The guide as plain numbered lines, no code: the story prompt's session input. */
export function changeGuideOutline(guide: ChangeGuide): string {
  const lines = guide.summary ? [guide.summary, ""] : [];
  guide.steps.forEach((s, i) => {
    const why = s.why.replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. ${s.title} (${stepLocation(s)})${why ? `: ${why}` : ""}`);
  });
  return lines.join("\n");
}
