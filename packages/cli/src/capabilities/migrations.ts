// Layout migrations: when the ledger's world changes shape, files MOVE.
//
// The defensive half of layout versioning lives in ownedJson.ts — a binary
// that sees a NEWER schema refuses to touch anything. This is the constructive
// half: a layout change ships as an explicit migration that moves files and
// rewrites ledger entries, never as "write the new place and let the old one
// rot". Rot is not hypothetical — an orphaned copy keeps loading in the client
// that found it first, and the user gets a skill that un-updates itself.
//
// One registry, ordered, each migration idempotent (safe to re-run after a
// crash mid-way: every step checks before acting). The first registered
// migration is the layout change that motivated the runner: per-client skill
// COPIES become one ~/.agents/skills content dir plus symlinks.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface MigrationReport {
  name: string;
  moved: string[];
  skipped: string[];
}

export interface Migration {
  name: string;
  /** Fast check: is there anything for this migration to do? */
  applies(home: string): boolean;
  /** Do it. Idempotent; every step re-checks before acting. */
  run(home: string, log: (line: string) => void): MigrationReport;
}

/** Clients whose skill dirs predate the shared layout. */
const LEGACY_SKILL_DIRS = [".claude/skills", ".cursor/skills"];

export const skillCopiesToSharedLinks: Migration = {
  name: "skill-copies-to-shared-links",

  applies(home) {
    for (const rel of LEGACY_SKILL_DIRS) {
      const dir = path.join(home, rel);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const p = path.join(dir, name);
        // A real directory (not a link) with a SKILL.md is a legacy copy.
        try {
          if (!fs.lstatSync(p).isSymbolicLink() && fs.existsSync(path.join(p, "SKILL.md"))) {
            return true;
          }
        } catch {
          // unreadable entry: not this migration's business
        }
      }
    }
    return false;
  },

  run(home, log) {
    const report: MigrationReport = { name: this.name, moved: [], skipped: [] };
    const sharedRoot = path.join(home, ".agents", "skills");

    for (const rel of LEGACY_SKILL_DIRS) {
      const dir = path.join(home, rel);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const legacy = path.join(dir, name);
        try {
          if (fs.lstatSync(legacy).isSymbolicLink()) continue; // already migrated
          if (!fs.existsSync(path.join(legacy, "SKILL.md"))) continue; // not a skill
        } catch {
          continue;
        }

        const shared = path.join(sharedRoot, name);
        if (fs.existsSync(shared)) {
          // Content already exists in the shared layout. Two different copies
          // is a conflict a migration must not resolve by deletion: the legacy
          // copy stays, gets reported, and a human (or a later apply with a
          // consented source of truth) decides.
          const same = sameTree(legacy, shared);
          if (!same) {
            report.skipped.push(`${legacy}: differs from ${shared}; left in place`);
            log(`[migrate] ${legacy} differs from shared copy — left for review`);
            continue;
          }
          fs.rmSync(legacy, { recursive: true });
        } else {
          fs.mkdirSync(sharedRoot, { recursive: true });
          fs.renameSync(legacy, shared);
        }
        try {
          fs.symlinkSync(shared, legacy);
          report.moved.push(`${legacy} -> ${shared}`);
          log(`[migrate] ${legacy} -> ${shared} (+link back)`);
        } catch {
          // No symlink support: move the content back rather than leave the
          // client dir empty — the migration must never LOSE a skill.
          fs.renameSync(shared, legacy);
          report.skipped.push(`${legacy}: filesystem refuses symlinks; copy left in place`);
        }
      }
    }
    return report;
  },
};

const MIGRATIONS: Migration[] = [skillCopiesToSharedLinks];

/** Run every applicable migration, in order. Called from the reconciler's
 *  startup path, under the target-root lock. */
export function runMigrations(
  home = process.env.HOME || os.homedir(),
  log: (line: string) => void = console.error,
): MigrationReport[] {
  const reports: MigrationReport[] = [];
  for (const migration of MIGRATIONS) {
    if (!migration.applies(home)) continue;
    reports.push(migration.run(home, log));
  }
  return reports;
}

function sameTree(a: string, b: string): boolean {
  const walk = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const visit = (rel: string) => {
      const abs = path.join(root, rel);
      for (const entry of fs.readdirSync(abs)) {
        const childRel = rel ? path.join(rel, entry) : entry;
        const child = path.join(root, childRel);
        if (fs.statSync(child).isDirectory()) visit(childRel);
        else out.set(childRel, fs.readFileSync(child, "utf-8"));
      }
    };
    visit("");
    return out;
  };
  try {
    const ta = walk(a);
    const tb = walk(b);
    if (ta.size !== tb.size) return false;
    for (const [rel, content] of ta) if (tb.get(rel) !== content) return false;
    return true;
  } catch {
    return false;
  }
}
