// Materializing a skill once, and linking it everywhere.
//
// The content lives in ~/.agents/skills/<name>/ — the cross-client directory
// Codex documents, Cursor reads, and skills.sh installs into — and each other
// client's skillsDir gets a SYMLINK. Claude Code follows symlinks and dedupes,
// so one set of bytes serves every client; three copies would drift the day
// any one of them is updated in place.
//
// The directory NAME is the identity, never the frontmatter name: two skills
// whose frontmatter both say "deploy" are still two skills if their dirs
// differ, and renaming a dir is renaming the skill.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { atomicWriteFile } from "../atomicWrite.js";

export interface SkillFile {
  /** Path inside the skill directory ("SKILL.md", "scripts/run.sh"). */
  relPath: string;
  content: string;
  mode?: number;
}

export interface MaterializeResult {
  /** The one real content directory. */
  contentDir: string;
  /** Per link target: "symlink" when a link was created or already right,
   *  "copy" when the machine (or an existing real directory) forced one. The
   *  ledger records this so removal knows what it owns at each path. */
  links: Record<string, "symlink" | "copy">;
  wroteFiles: number;
}

/** Where the shared content lives. */
export function sharedSkillDir(name: string, home = process.env.HOME || os.homedir()): string {
  return path.join(home, ".agents", "skills", name);
}

/**
 * Write the skill's files into the shared directory, then link it into each
 * client directory. Idempotent: unchanged files are not rewritten, correct
 * links are left alone, and the second run reports zero writes.
 */
export function materializeSkill(
  name: string,
  files: SkillFile[],
  clientSkillDirs: string[],
  home = process.env.HOME || os.homedir(),
): MaterializeResult {
  const contentDir = sharedSkillDir(name, home);
  fs.mkdirSync(contentDir, { recursive: true });

  let wroteFiles = 0;
  for (const file of files) {
    const target = path.join(contentDir, file.relPath);
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(target, "utf-8");
    } catch {
      existing = undefined;
    }
    if (existing === file.content) continue;
    atomicWriteFile(target, file.content, file.mode !== undefined ? { mode: file.mode } : {});
    wroteFiles++;
  }

  const links: Record<string, "symlink" | "copy"> = {};
  for (const clientDir of clientSkillDirs) {
    const linkPath = path.join(clientDir, name);
    links[linkPath] = ensureLink(contentDir, linkPath, files);
  }
  return { contentDir, links, wroteFiles };
}

/**
 * Point `linkPath` at `contentDir`, or fall back to a copy.
 *
 * The fallback is a probe AT WRITE TIME, not a platform guess: a filesystem
 * that cannot create symlinks throws here and nowhere else, and a REAL
 * directory already sitting at the link path is the user's (or an older
 * layout's) — replacing it with a link would delete content we do not own, so
 * it is left standing and refreshed as a copy instead.
 */
function ensureLink(contentDir: string, linkPath: string, files: SkillFile[]): "symlink" | "copy" {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    stat = undefined;
  }

  if (stat?.isSymbolicLink()) {
    try {
      if (fs.realpathSync(linkPath) === fs.realpathSync(contentDir)) return "symlink";
      fs.unlinkSync(linkPath); // our old link to an old location: retarget
    } catch {
      fs.unlinkSync(linkPath); // dangling: replace
    }
    stat = undefined;
  }

  if (stat?.isDirectory()) {
    // A real directory at the link path. Not ours to delete — refresh contents.
    for (const file of files) {
      const target = path.join(linkPath, file.relPath);
      let existing: string | undefined;
      try {
        existing = fs.readFileSync(target, "utf-8");
      } catch {
        existing = undefined;
      }
      if (existing !== file.content) {
        atomicWriteFile(target, file.content, file.mode !== undefined ? { mode: file.mode } : {});
      }
    }
    return "copy";
  }

  try {
    fs.symlinkSync(contentDir, linkPath);
    return "symlink";
  } catch {
    // The probe: this filesystem will not link. Copy instead, and say so.
    for (const file of files) {
      atomicWriteFile(path.join(linkPath, file.relPath), file.content, {});
    }
    return "copy";
  }
}
