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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { atomicWriteFile } from "../atomicWrite.js";

/* ==========================================================================
 * The op union — phase 2 arms only
 * ========================================================================== */

// A per-client op registry waits until a third genuinely different writer
// exists; today the per-client fact is a file path, and that lives in
// agentFileTargets where it belongs.
export type PlannedOp =
  | { op: "write_file"; path: string; content: string; mode?: number; slug: string }
  | { op: "symlink"; path: string; target: string; slug: string }
  | { op: "remove"; path: string; slug: string }
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
function realTarget(p: string): string {
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
  const trim = (s: string) =>
    s
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "\n");
  return trim(a) === trim(b);
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
 * apply()
 * ========================================================================== */

export interface ApplyOutcome {
  wrote: string[];
  removed: string[];
  conflicts: Array<{ slug: string; reason: string; detail?: string }>;
  /** The ledger after this apply — caller persists it. */
  ledger: DriverLedger;
}

/**
 * Execute a plan. Writes go through atomicWriteFile; every write lands in the
 * ledger; removal deletes exactly the listed files, then their directory ONLY
 * if empty — never a recursive delete of a directory this driver did not
 * create, because a skill dir can hold a user's uncommitted edits.
 */
export function apply(ops: PlannedOp[], ledger: DriverLedger): ApplyOutcome {
  const next: DriverLedger = { files: { ...ledger.files } };
  const outcome: ApplyOutcome = { wrote: [], removed: [], conflicts: [], ledger: next };

  for (const op of ops) {
    if (op.op === "conflict") {
      outcome.conflicts.push({ slug: op.slug, reason: op.reason, detail: op.detail });
      continue;
    }
    if (op.op === "write_file") {
      atomicWriteFile(op.path, op.content, op.mode !== undefined ? { mode: op.mode } : {});
      const list = next.files[op.slug] ?? [];
      if (!list.includes(op.path)) list.push(op.path);
      next.files[op.slug] = list;
      outcome.wrote.push(op.path);
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
      const list = next.files[op.slug] ?? [];
      if (!list.includes(op.path)) list.push(op.path);
      next.files[op.slug] = list;
      outcome.wrote.push(op.path);
      continue;
    }
    // remove
    try {
      fs.unlinkSync(op.path);
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
