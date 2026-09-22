// The one strict collector for "files a repository asks to be copied alongside
// its git content" — the manifest's setup.copy: .env, credentials, whatever a
// project declares for a fresh worktree.
//
// Those entries come out of a file in the repository, so they are attacker
// controlled whenever a repository has more than one author. A relative name
// with .. in it, an absolute path, or a path that walks through a symlink
// reaches files the user never meant to hand over, and both remote-copy paths
// then rsync them to a host. The cloud path has enforced this boundary since it
// shipped; the older remote move path joined the raw entries straight into the
// two worktrees and copied whatever came out.
//
// So the rules live here and both callers use them:
//   - a copy entry is a relative path with no "..", no ".", no ".git", no
//     backslash or control character, and no empty segment;
//   - no segment of it may be a symlink, checked with lstat at every level, so
//     an intermediate link cannot redirect the walk;
//   - a directory expands to the regular files under it, nothing else;
//   - an invalid manifest FAILS, rather than quietly falling back to a default
//     list, which would hide the rejection.

import * as fs from "node:fs";
import * as path from "node:path";
import { ManifestError } from "./manifest.js";
import { resolveManifest } from "./resolver.js";

/** A copy entry names a file inside the repository and nothing else. */
export function validateRelativePath(rel: string): void {
  if (
    !rel ||
    /[\\:\x00-\x1f\x7f]/.test(rel) ||
    rel.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error(`unsafe workspace copy path: ${JSON.stringify(rel)}`);
  }
}

/** lstat the entry one segment at a time. Undefined when it does not exist;
 *  throws when any segment is a symlink, because a link anywhere on the way
 *  makes the containment check above meaningless. */
export function sourceStat(root: string, rel: string): fs.Stats | undefined {
  validateRelativePath(rel);
  let current = root;
  let stat: fs.Stats | undefined;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new Error(`workspace copy refuses symlink: ${rel}`);
  }
  return stat;
}

/** A manifest that exists and does not parse. Distinct from a resolver that
 *  could not run at all (no git, no project detection): the first is a broken
 *  declaration that must fail loudly, the second is an ordinary directory that
 *  simply has no manifest, and callers treat them differently. */
export class InvalidWorkspaceManifest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceManifest";
  }
}

/** The manifest's declared copy list. Throws InvalidWorkspaceManifest for a
 *  manifest that does not parse, and rethrows anything else, so a caller can
 *  tell the two apart. A manifest that declares nothing returns an empty list
 *  — that is a project with nothing to copy, not a broken one. */
export function manifestCopyEntries(root: string, failMessage = "invalid workspace manifest; fix .codecast/workspace.toml before copying setup files"): string[] {
  try {
    return resolveManifest(root).setup.copy;
  } catch (err) {
    if (!(err instanceof ManifestError)) throw err;
    throw new InvalidWorkspaceManifest(failMessage);
  }
}

export interface CollectCopyOptions {
  /** Paths already known to be inside the project; they skip the stat walk.
   *  The cloud path passes its project context here. */
  known?: ReadonlySet<string>;
}

/**
 * Expand copy entries into the regular files to transfer, relative to `root`.
 * Every entry is validated before a single filesystem call, and a directory
 * expands into its regular files. An entry that does not exist is skipped —
 * a project declaring .env.production on a machine that has none is normal.
 */
export function collectCopyFiles(root: string, entries: readonly string[], opts: CollectCopyOptions = {}): string[] {
  const files = new Set<string>();
  const visit = (rel: string): void => {
    validateRelativePath(rel);
    if (opts.known?.has(rel)) {
      files.add(rel);
      return;
    }
    const stat = sourceStat(root, rel);
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(path.join(root, rel))) visit(`${rel}/${child}`);
    } else if (stat.isFile()) {
      files.add(rel);
    } else {
      throw new Error(`workspace copy requires a regular file: ${rel}`);
    }
  };
  for (const rel of entries) visit(rel);
  return [...files];
}

/** Where a validated relative file lands under a destination root, as a posix
 *  path. Asserts containment independently of the validation above: the
 *  destination is the other half of the boundary, and it is cheap to prove. */
export function containedRemotePath(destRoot: string, rel: string): string {
  validateRelativePath(rel);
  const joined = path.posix.join(destRoot, rel.split(path.sep).join("/"));
  const fence = destRoot.endsWith("/") ? destRoot : `${destRoot}/`;
  if (!joined.startsWith(fence)) throw new Error(`workspace copy escapes the destination: ${JSON.stringify(rel)}`);
  return joined;
}
