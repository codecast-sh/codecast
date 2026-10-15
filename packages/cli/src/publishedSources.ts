// Every extractor and judge a repo publishes (`cast line moments publish`,
// docs/architecture/learning-loop.md LL7), kept by version in a git repo of
// its own under EVALS_HOME (`published/`), outside the product's checkout.
//
// A moment's extractor version and a finding's judge_version are the file's
// git blob hash (momentsHost.fileVersion), so committing the file here stores
// it under exactly that id: `git -C <home>/published cat-file -p <version>`
// prints the text that produced a finding, even after the checkout it was
// published from lost the file, and `git log -- <source>/<path>` lists every
// version in order. One commit per publish that changed anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "./proc.js";
import { evalsHomeDir } from "./evals/evalsBridge.js";

export const publishedSourcesDir = (home = evalsHomeDir()) => path.join(home, "published");

const git = (dir: string, args: string[], input?: string) =>
  spawnSync("git", ["-C", dir, "-c", "user.name=codecast", "-c", "user.email=publish@codecast.local", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", input });

/**
 * Copy each published file (repo-relative `path`, from `root`) to
 * `<dir>/<source>/<path>` and commit what changed. Returns the commit, or
 * null when every file was already kept at its version. Throws when a kept
 * copy's blob hash is not the version it was published under.
 */
export function archivePublished(root: string, source: string, files: Array<{ path: string; version: string }>, dir = publishedSourcesDir()): { dir: string; commit: string | null } {
  const name = source.replace(/[^A-Za-z0-9_.-]/g, "_");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git")) && git(dir, ["init", "-q"]).status !== 0) throw new Error(`git init failed in ${dir}`);
  const kept: string[] = [];
  for (const f of files) {
    const rel = path.posix.join(name, f.path);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, f.path), dest);
    const hash = git(dir, ["hash-object", "--", rel]).stdout.trim();
    if (hash !== f.version) throw new Error(`${rel} hashes to ${hash.slice(0, 10)}, not the published ${f.version.slice(0, 10)}`);
    kept.push(rel);
  }
  if (!kept.length) return { dir, commit: null };
  git(dir, ["add", "--", ...kept]);
  if (git(dir, ["diff", "--cached", "--quiet"]).status === 0) return { dir, commit: null };
  const message = `publish ${source}\n\n${files.map((f) => `${f.path} ${f.version}`).join("\n")}\nfrom ${root}\n`;
  const committed = git(dir, ["commit", "-q", "-F", "-"], message);
  if (committed.status !== 0) throw new Error(`git commit failed in ${dir}: ${committed.stderr.trim()}`);
  return { dir, commit: git(dir, ["rev-parse", "HEAD"]).stdout.trim() };
}
