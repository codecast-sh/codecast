/**
 * File completion for the composer's @ menu: the files of one project, matched
 * against what was typed after the @.
 *
 * A git checkout lists itself (`git ls-files` for tracked and untracked files,
 * minus what .gitignore drops), which is what the agent in that folder would
 * see. Any other folder gets a bounded walk that skips dot directories and
 * dependency folders. A project's list is kept for a short while so every
 * keystroke of one mention reuses it.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "../proc.js";

const LIST_TTL_MS = 15_000;
const MAX_FILES = 50_000;
const DEFAULT_LIMIT = 40;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor", "__pycache__"]);

export type ListFiles = (root: string) => Promise<string[] | null>;

const lists = new Map<string, { at: number; files: Promise<string[] | null> }>();

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const files = [...new Set(String(stdout).split("\0").filter(Boolean))];
        resolve(files.slice(0, MAX_FILES));
      },
    );
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [""];
  while (queue.length && out.length < MAX_FILES) {
    const rel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(child);
      } else if (e.isFile()) {
        out.push(child);
      }
    }
  }
  return out;
}

/** Every file in `root`, relative to it; null when `root` is not a directory. */
export const listProjectFiles: ListFiles = async (root) => {
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) return null;
  } catch {
    return null;
  }
  return fs.existsSync(path.join(root, ".git")) ? ((await gitFiles(root)) ?? walkFiles(root)) : walkFiles(root);
};

// A list older than the TTL is still answered from while a fresh one is read,
// so only the first @ in a project waits on the listing.
function cachedFiles(root: string, list: ListFiles): Promise<string[] | null> {
  const hit = lists.get(root);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.files;
  const files = list(root);
  // Until the fresh list lands, later calls keep getting the old one.
  lists.set(root, { at: Date.now(), files: hit?.files ?? files });
  files.then(
    (f) => { if (f) lists.set(root, { at: Date.now(), files }); else lists.delete(root); },
    () => lists.delete(root),
  );
  return hit?.files ?? files;
}

/**
 * How well a relative path answers the query; lower is better, Infinity is no
 * match. Every space-separated word must appear in the path. A file whose name
 * starts with the query beats one whose name merely contains it, which beats a
 * hit in the directories; shorter paths break ties.
 */
export function fileMatchRank(rel: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return rel.split("/").length * 1000 + rel.length;
  const lower = rel.toLowerCase();
  const words = q.split(/\s+/);
  if (!words.every((w) => lower.includes(w))) return Infinity;
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const tier = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : lower.includes(q) ? 3 : 4;
  return tier * 100_000 + rel.length;
}

export async function searchProjectFiles(
  root: string,
  query: string,
  limit = DEFAULT_LIMIT,
  list: ListFiles = listProjectFiles,
): Promise<{ root: string; exists: boolean; files: string[] }> {
  const files = await cachedFiles(root, list);
  if (!files) return { root, exists: false, files: [] };
  const ranked: Array<[number, string]> = [];
  for (const f of files) {
    const r = fileMatchRank(f, query);
    if (r !== Infinity) ranked.push([r, f]);
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return { root, exists: true, files: ranked.slice(0, limit).map(([, f]) => f) };
}
