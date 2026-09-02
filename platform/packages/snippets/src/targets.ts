// Which instruction files on this machine to write into.
//
// The consumer declares the candidates (one per agent client it knows about);
// this resolves them against a home directory and a filesystem. Two behaviors
// carry over from the donor exactly, and one side effect stays dropped:
// `always` clients get their file whether or not the directory exists (the
// host CLI's own client), any other candidate is included only when its config
// directory already exists (the long-standing signal for "installed here"),
// and enumerating targets creates nothing on disk. Directory creation belongs
// to the writer.

import * as path from "path";
import type { SnippetFs, SnippetTarget } from "./types";

export interface TargetCandidate {
  /** The declared user instruction file, `~` allowed: "~/.claude/CLAUDE.md". */
  path: string;
  /** Include even when the directory does not exist yet; the writer creates it. */
  always?: boolean;
}

export interface ResolvedTarget extends SnippetTarget {
  dirPath: string;
  label: string;
}

export function resolveTargets(
  candidates: TargetCandidate[],
  opts: { home: string; fs: SnippetFs },
): ResolvedTarget[] {
  const targets: ResolvedTarget[] = [];
  for (const candidate of candidates) {
    const filePath = candidate.path.replace(/^~(?=\/)/, opts.home);
    const dirPath = path.dirname(filePath);
    if (!candidate.always && !opts.fs.exists(dirPath)) continue;
    targets.push({ filePath, dirPath, label: candidate.path });
  }
  return targets;
}
