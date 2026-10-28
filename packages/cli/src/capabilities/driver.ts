// The driver: turning a resolved desire into file operations, and executing
// them. Two halves with one hard boundary — plan() is the ONLY thing allowed to
// decide whether to write, and apply() is the only thing allowed to touch the
// disk. Everything above them reasons about intent; everything below is bytes.
//
// The security posture, stated once for both halves: a capability SOURCE (a
// marketplace manifest, a git repo, a registry row) never chooses a path. Every
// path is DERIVED here from the client registry's agentFileTargets plus the
// capability's kind. A manifest declaring {op: "symlink", path:
// "~/.claude/settings.json"} would otherwise make the daemon write anywhere the
// user can write. A source-supplied writes[] list is kept only to COMPARE, and
// a mismatch is a conflict and a refusal, never a merge.

import { recordHarnessChange, removeHarnessFile, writeHarnessFile } from "../harness.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findOwnedSections, getProjectSnippetTargets, getSnippetTargets, writeOwnedSection, type SectionSpec } from "../snippets.js";
import { contentHash, judgeOwnedFile, type OwnedFileRecord } from "./handEdit.js";
import { checkProjectWrite, type ProjectWritesSetting } from "./projectWrites.js";

/* ==========================================================================
 * The op union — phase 2 arms only
 * ========================================================================== */

// A per-client op registry waits until a third genuinely different writer
// exists; today the per-client fact is a file path, and that lives in
// agentFileTargets where it belongs.
export type PlannedOp =
  /** `bytes`, when present, is what lands on disk: a file that is not text
   *  (an image in a skill), which `content` as a string would corrupt. */
  | { op: "write_file"; path: string; content: string; bytes?: Uint8Array; mode?: number; slug: string }
  | { op: "symlink"; path: string; target: string; slug: string }
  | { op: "remove"; path: string; slug: string }
  /** A file or directory someone else made, renamed to `to` (never deleted)
   *  because its owner chose the capability's copy over theirs. */
  | { op: "move_aside"; path: string; to: string; slug: string }
  /** One owned region of a markdown instruction file: `body` written in place
   *  (or appended), or the region cut with `body: null`. `record` is what the
   *  ledger holds for (slug, path) afterwards; absent drops the entry. */
  | { op: "markdown_section"; path: string; slug: string; spec: SectionSpec; body: string | null; record?: SectionRecord }
  | { op: "conflict"; slug: string; reason: string; detail?: string };

/** One capability's desired materialization, already resolved and consented. */
export interface DesiredFile {
  slug: string;
  /** Derived by the caller from agentFileTargets + kind — never from a source. */
  relPath: string;
  content: string;
  mode?: number;
  /** What the SOURCE claims it writes, when it claims anything. Compared,
   *  never obeyed. */
  declaredWrites?: string[];
}

export interface DriverLedger {
  /** Absolute paths this driver wrote, per slug, from previous applies. */
  files: Record<string, string[]>;
  /** Owned markdown regions, per slug, per instruction file. Kept apart from
   *  `files` because removing a section cuts a region and must never delete
   *  the file around it. */
  sections?: Record<string, Record<string, SectionRecord>>;
}

/** What the ledger knows about one region we wrote: the hand-edit record, and
 *  the repository it sits in when it is a project file, so a later cut is
 *  checked against git the same way the write was. */
export interface SectionRecord extends OwnedFileRecord {
  projectRoot?: string;
}

/* ==========================================================================
 * plan()
 * ========================================================================== */

/** The only directories a derived path may resolve into. Narrow on purpose:
 *  widening this list is a review event, because every entry is somewhere the
 *  daemon will write bytes chosen by third parties. */
export function allowedRoots(home = os.homedir()): string[] {
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", "agents"),
    path.join(home, ".claude", "commands"),
    path.join(home, ".agents", "skills"),
  ];
}

/** Resolve symlinks on the deepest EXISTING ancestor, so a link planted inside
 *  an allowed root cannot smuggle a write outside it. */
export function realTarget(p: string): string {
  let probe = path.dirname(p);
  const tail: string[] = [path.basename(p)];
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...tail);
    } catch {
      tail.unshift(path.basename(probe));
      const up = path.dirname(probe);
      if (up === probe) return p;
      probe = up;
    }
  }
}

/** Normalized equality: parsed for JSON, trailing-whitespace-insensitive for
 *  text. The reason plan() owns equality: a driver reporting zero ops must
 *  write zero bytes, and byte-compare would rewrite a file over a formatting
 *  difference no tool cares about. */
export function contentEqual(a: string, b: string, filePath: string): boolean {
  if (filePath.endsWith(".json")) {
    try {
      return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
    } catch {
      // Unparseable on either side: fall through to text comparison.
    }
  }
  return normalizeText(a) === normalizeText(b);
}

/** Text as contentEqual compares it: trailing whitespace off every line and
 *  one newline at the end. */
export function normalizeText(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "\n");
}

export function plan(
  desired: DesiredFile[],
  ledger: DriverLedger,
  opts: { home?: string; roots?: string[] } = {},
): PlannedOp[] {
  const home = opts.home ?? os.homedir();
  const roots = (opts.roots ?? allowedRoots(home)).map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return r;
    }
  });
  const ops: PlannedOp[] = [];
  const plannedPaths = new Set<string>();

  for (const want of desired) {
    // A source that declares its own writes[] gets them CHECKED, not obeyed.
    // Anything it names outside what we derived is an attempt to choose a
    // path, and the whole entry is refused — half-applying a capability whose
    // manifest lies is worse than not applying it.
    if (want.declaredWrites && want.declaredWrites.length > 0) {
      const derived = new Set([want.relPath]);
      const foreign = want.declaredWrites.filter((w) => !derived.has(w));
      if (foreign.length > 0) {
        ops.push({
          op: "conflict",
          slug: want.slug,
          reason: "declared_writes_mismatch",
          detail: `manifest claims it writes ${foreign[0]}, which is not where a ${
            want.slug
          } materializes — refusing the whole entry`,
        });
        continue;
      }
    }

    const abs = realTarget(path.resolve(home, want.relPath));
    const inRoots = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
    if (!inRoots) {
      ops.push({
        op: "conflict",
        slug: want.slug,
        reason: "path_outside_roots",
        detail: `${want.relPath} resolves to ${abs}, outside every allowed root`,
      });
      continue;
    }

    plannedPaths.add(abs);
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(abs, "utf-8");
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && contentEqual(existing, want.content, abs)) {
      continue; // steady state: zero ops is the point
    }
    ops.push({ op: "write_file", path: abs, content: want.content, mode: want.mode, slug: want.slug });
  }

  // Removal: exactly what the ledger records and the desire no longer wants.
  const wantedSlugs = new Set(desired.map((d) => d.slug));
  for (const [slug, files] of Object.entries(ledger.files)) {
    if (wantedSlugs.has(slug)) continue;
    for (const file of files) {
      const abs = realTarget(path.resolve(file));
      const inRoots = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
      if (!inRoots) {
        // A ledger entry outside the roots is a corrupted or tampered ledger;
        // refusing loudly beats deleting whatever it points at now.
        ops.push({
          op: "conflict",
          slug,
          reason: "ledger_path_outside_roots",
          detail: `ledger names ${file}; refusing to remove anything outside the allowed roots`,
        });
        continue;
      }
      if (plannedPaths.has(abs)) continue;
      ops.push({ op: "remove", path: abs, slug });
    }
  }

  return ops;
}

/* ==========================================================================
 * planSections(): the markdown_section arm
 * ========================================================================== */

/** One prose capability's desired region. Like DesiredFile it names no path:
 *  the files are the agent instruction files the client registry declares
 *  (getSnippetTargets), or their project-level twins under `projectRoot`. */
export interface DesiredSection {
  slug: string;
  /** The region's `## ` heading line. */
  heading: string;
  body: string;
  /** A repository root for a project-scope section; absent for the user's own
   *  instruction files. */
  projectRoot?: string;
}

export interface SectionPlanOptions {
  home: string;
  /** The device setting capabilities.project_writes. */
  projectWrites?: ProjectWritesSetting;
  /** The explicit gesture that lets a project section land in a tracked file. */
  overrideTracked?: boolean;
  /** Slugs still wanted whose content this pass could not resolve: neither
   *  written nor cut. */
  hold?: string[];
  log?: (line: string) => void;
}

/** The end marker that makes a region ours. Derived from the slug, so a
 *  region is found again whatever its heading has become since. */
export function sectionMarker(slug: string): string {
  return `<!-- /codecast-kit ${slug} -->`;
}

/** A slug that could close the comment or break the marker out of its line
 *  never reaches a file. */
const MARKER_SAFE = /^[A-Za-z0-9._:\/-]+$/;

/** The heading line, made safe to own: one line, and a level-2 heading. */
function headingLine(heading: string): string {
  const flat = heading.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
  return `## ${flat}`;
}

/** The body as it sits inside the region: a top-level heading in it would end
 *  the region early (findOwnedSections stops at the next `## `), so headings
 *  of level one and two drop to level three. */
function regionBody(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/^#{1,2}(?=\s)/, "###"))
    .join("\n")
    .trim();
}

/** The section as the writer receives it: padded with one newline at each
 *  end, the shape every builtin body has (the append path wants the leading
 *  newline; the in-place path trims it). */
export function renderOwnedSection(heading: string, body: string, slug: string): string {
  return `\n${headingLine(heading)}\n\n${regionBody(body)}\n\n${sectionMarker(slug)}\n`;
}

/** Every heading a region carrying `marker` sits under, so a renamed team or
 *  item replaces its old region instead of stacking a second one. */
function headingsBefore(text: string, marker: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
    const start = text.lastIndexOf("\n## ", at);
    const lineStart = start === -1 ? (text.startsWith("## ") ? 0 : -1) : start + 1;
    if (lineStart === -1) continue;
    const lineEnd = text.indexOf("\n", lineStart);
    out.push(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd));
  }
  return out;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** The spec that finds this slug's region in `text`, and the region itself
 *  normalized, or undefined when the file holds none. */
function ownedRegion(text: string | undefined, slug: string, heading?: string) {
  const endMarker = sectionMarker(slug);
  const found = text === undefined ? [] : headingsBefore(text, endMarker);
  const headings = [...new Set([...(heading ? [heading] : []), ...found])];
  const spec: SectionSpec = { headings: headings.length ? headings : [heading ?? "## "], endMarker };
  const block = text === undefined ? undefined : findOwnedSections(text, spec)[0];
  return { spec, region: block ? normalizeText(text!.slice(block.start, block.end)) : undefined };
}

/** Every kit region in an instruction file: its slug, heading line, the body
 *  between them, and its [start, end) offsets. For readers (promote) that need
 *  to tell the team's installed sections from the person's own lines. */
export function findKitSections(text: string): Array<{ slug: string; heading: string; body: string; start: number; end: number }> {
  const out: Array<{ slug: string; heading: string; body: string; start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/<!-- \/codecast-kit ([A-Za-z0-9._:\/-]+) -->/g)) {
    const slug = m[1]!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const { spec } = ownedRegion(text, slug);
    for (const block of findOwnedSections(text, spec)) {
      const region = text.slice(block.start, block.end);
      const nl = region.indexOf("\n");
      const heading = region.slice(0, nl === -1 ? undefined : nl);
      const body = region.slice(heading.length).split(spec.endMarker).join("").trim();
      out.push({ slug, heading, body, start: block.start, end: block.end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Plan the owned markdown regions. The same five-case model handEdit.ts gives
 * whole files, applied to one region per (slug, file):
 *
 * - no record yet: write (in place when a region with our marker exists)
 * - region equals desired: zero ops
 * - region equals what we last wrote: rewrite to desired
 * - region differs from what we wrote: locally_modified conflict, no write
 * - region gone: recreated once, then locally_removed and left alone
 *
 * A slug the ledger holds that is no longer desired is cut, unless its region
 * was edited by hand, which is a conflict instead: the edit is theirs now.
 * Equality is normalizeText, the driver's trailing-whitespace rule.
 */
export function planSections(desired: DesiredSection[], ledger: DriverLedger, opts: SectionPlanOptions): PlannedOp[] {
  const ops: PlannedOp[] = [];
  const records = ledger.sections ?? {};
  const guard = (file: string, projectRoot: string | undefined, slug: string): boolean => {
    if (!projectRoot) return true;
    const verdict = checkProjectWrite(file, { setting: opts.projectWrites, overrideTracked: opts.overrideTracked, log: opts.log });
    if (verdict.ok) return true;
    ops.push({ op: "conflict", slug, reason: "project_write_refused", detail: verdict.detail });
    return false;
  };

  for (const want of desired) {
    if (!MARKER_SAFE.test(want.slug)) {
      ops.push({ op: "conflict", slug: want.slug, reason: "invalid_slug", detail: "a section slug may hold only letters, digits and ._:/-" });
      continue;
    }
    const heading = headingLine(want.heading);
    const body = renderOwnedSection(want.heading, want.body, want.slug);
    const desiredRegion = normalizeText(body.replace(/^\n+/, ""));
    const targets = want.projectRoot ? getProjectSnippetTargets(want.projectRoot, opts.home) : getSnippetTargets(opts.home);

    for (const target of targets) {
      const text = readText(target.filePath);
      const { spec, region } = ownedRegion(text, want.slug, heading);
      let record: SectionRecord | undefined = records[want.slug]?.[target.filePath];
      // A missing directory is not a deletion of our region: the whole tree
      // moved or was never there. First-install semantics apply.
      if (text === undefined && !fs.existsSync(path.dirname(target.filePath))) record = undefined;

      const verdict = judgeOwnedFile(record, region, desiredRegion);
      if (verdict.action === "none") continue;
      if (verdict.action === "conflict") {
        ops.push({ op: "conflict", slug: want.slug, reason: "locally_modified", detail: target.filePath });
        continue;
      }
      if (verdict.action === "hold") {
        ops.push({ op: "conflict", slug: want.slug, reason: "locally_removed", detail: target.filePath });
        continue;
      }
      if (!guard(target.filePath, want.projectRoot, want.slug)) continue;
      ops.push({
        op: "markdown_section",
        path: target.filePath,
        slug: want.slug,
        spec,
        body,
        record: {
          wroteHash: contentHash(desiredRegion),
          ...(verdict.action === "recreate" || record?.recreatedOnce ? { recreatedOnce: true } : {}),
          ...(want.projectRoot ? { projectRoot: want.projectRoot } : {}),
        },
      });
    }
  }

  const keep = new Set([...desired.map((d) => d.slug), ...(opts.hold ?? [])]);
  for (const [slug, files] of Object.entries(records)) {
    if (keep.has(slug)) continue;
    for (const [file, record] of Object.entries(files)) {
      const { spec, region } = ownedRegion(readText(file), slug);
      if (region === undefined) {
        ops.push({ op: "markdown_section", path: file, slug, spec, body: null }); // already gone: forget it
        continue;
      }
      if (contentHash(region) !== record.wroteHash) {
        ops.push({ op: "conflict", slug, reason: "locally_modified", detail: file });
        continue;
      }
      if (!guard(file, record.projectRoot, slug)) continue;
      ops.push({ op: "markdown_section", path: file, slug, spec, body: null });
    }
  }
  return ops;
}

/* ==========================================================================
 * apply()
 * ========================================================================== */

export interface ApplyOutcome {
  wrote: string[];
  removed: string[];
  conflicts: Array<{ slug: string; reason: string; detail?: string }>;
  /** Paths renamed out of the way by move_aside. */
  moved: Array<{ slug: string; from: string; to: string }>;
  /** The ledger after this apply — caller persists it. */
  ledger: DriverLedger;
}

/**
 * Execute a plan. Writes go through writeHarnessFile (atomic, and recorded in
 * the harness change history); every write lands in the
 * ledger; removal deletes exactly the listed files, then their directory ONLY
 * if empty — never a recursive delete of a directory this driver did not
 * create, because a skill dir can hold a user's uncommitted edits.
 */
export function apply(ops: PlannedOp[], ledger: DriverLedger): ApplyOutcome {
  const next: DriverLedger = { ...ledger, files: { ...ledger.files } };
  if (ledger.sections) {
    next.sections = Object.fromEntries(Object.entries(ledger.sections).map(([k, v]) => [k, { ...v }]));
  }
  const outcome: ApplyOutcome = { wrote: [], removed: [], conflicts: [], moved: [], ledger: next };
  // A slug whose move_aside failed writes nothing more: its later ops would
  // land on the very file that could not be moved.
  const halted = new Set<string>();

  for (const op of ops) {
    if (halted.has(op.slug)) continue;
    if (op.op === "conflict") {
      outcome.conflicts.push({ slug: op.slug, reason: op.reason, detail: op.detail });
      continue;
    }
    if (op.op === "write_file") {
      writeHarnessFile(op.path, op.bytes ?? op.content, `capability:${op.slug}`, {
        mode: op.mode,
        executable: op.mode !== undefined && (op.mode & 0o111) !== 0,
      });
      const list = next.files[op.slug] ?? [];
      if (!list.includes(op.path)) list.push(op.path);
      next.files[op.slug] = list;
      outcome.wrote.push(op.path);
      continue;
    }
    if (op.op === "markdown_section") {
      const changed = writeOwnedSection({ filePath: op.path }, op.spec, op.body, `capability:${op.slug}`);
      if (changed) (op.body === null ? outcome.removed : outcome.wrote).push(op.path);
      const sections = (next.sections ??= {});
      const files = (sections[op.slug] ??= {});
      if (op.record) files[op.path] = op.record;
      else delete files[op.path];
      if (Object.keys(files).length === 0) delete sections[op.slug];
      continue;
    }
    if (op.op === "move_aside") {
      try {
        fs.mkdirSync(path.dirname(op.to), { recursive: true });
        fs.renameSync(op.path, op.to);
        recordHarnessChange(op.path, "removed", `capability:${op.slug} (moved aside to ${path.basename(op.to)})`);
        recordHarnessChange(op.to, "created", `capability:${op.slug} (the original, moved aside)`);
        outcome.moved.push({ slug: op.slug, from: op.path, to: op.to });
      } catch (err) {
        outcome.conflicts.push({ slug: op.slug, reason: "move_aside_failed", detail: `${op.path}: ${String(err).slice(0, 160)}` });
        halted.add(op.slug);
      }
      continue;
    }
    if (op.op === "symlink") {
      fs.mkdirSync(path.dirname(op.path), { recursive: true });
      try {
        fs.unlinkSync(op.path);
      } catch {
        // absent is fine
      }
      fs.symlinkSync(op.target, op.path);
      recordHarnessChange(op.path, "created", `capability:${op.slug}`);
      const list = next.files[op.slug] ?? [];
      if (!list.includes(op.path)) list.push(op.path);
      next.files[op.slug] = list;
      outcome.wrote.push(op.path);
      continue;
    }
    // remove
    try {
      if (!removeHarnessFile(op.path, `capability:${op.slug}`)) fs.unlinkSync(op.path);
      outcome.removed.push(op.path);
    } catch {
      // Already gone: removal is idempotent.
    }
    const remaining = (next.files[op.slug] ?? []).filter((f) => f !== op.path);
    if (remaining.length === 0) delete next.files[op.slug];
    else next.files[op.slug] = remaining;
    // The directory goes only when WE emptied it.
    try {
      const dir = path.dirname(op.path);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // Not empty, or already gone — both fine.
    }
  }
  return outcome;
}
