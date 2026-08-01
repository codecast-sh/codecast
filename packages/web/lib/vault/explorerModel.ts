// The vault explorer's pure model: the folder tree it renders, the order rows
// appear in, and the naming rules behind new-note/new-folder/rename. No React
// here, so the rules are unit-testable and so the header buttons and the row
// context menu share one implementation instead of two that drift.

import { isVaultIgnoredPath, isVaultMarkdownPath, type VaultFileEntry } from "@codecast/shared/contracts";

export type VaultSortMode = "name-asc" | "name-desc" | "mtime-desc" | "mtime-asc";

export const VAULT_SORT_OPTIONS: { id: VaultSortMode; label: string }[] = [
  { id: "name-asc", label: "Name A→Z" },
  { id: "name-desc", label: "Name Z→A" },
  { id: "mtime-desc", label: "Modified new→old" },
  { id: "mtime-asc", label: "Modified old→new" },
];

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
  noteCount: number;
  /** Newest mtime in the subtree — what the "Modified" sort orders folders by. */
  mtime: number;
}

const byName = (a: TreeNode, b: TreeNode) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** Folders always sort before files (Obsidian's rule); the mode orders within
 *  each group, falling back to name so equal mtimes stay stable. */
function comparator(mode: VaultSortMode): (a: TreeNode, b: TreeNode) => number {
  return (a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    switch (mode) {
      case "name-desc": return -byName(a, b);
      case "mtime-desc": return b.mtime - a.mtime || byName(a, b);
      case "mtime-asc": return a.mtime - b.mtime || byName(a, b);
      default: return byName(a, b);
    }
  };
}

export function buildVaultTree(
  files: Record<string, VaultFileEntry>,
  sortMode: VaultSortMode = "name-asc",
): TreeNode {
  const root: TreeNode = { name: "", path: "", dir: true, children: [], noteCount: 0, mtime: 0 };
  const dirNodes = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirNodes.get(path);
    if (existing) return existing;
    const idx = path.lastIndexOf("/");
    const parent = ensureDir(idx === -1 ? "" : path.slice(0, idx));
    const node: TreeNode = {
      name: path.slice(idx + 1),
      path,
      dir: true,
      children: [],
      noteCount: 0,
      mtime: files[path]?.mtime ?? 0,
    };
    parent.children.push(node);
    dirNodes.set(path, node);
    return node;
  };

  for (const f of Object.values(files)) {
    if (f.dir) {
      ensureDir(f.path);
      continue;
    }
    const idx = f.path.lastIndexOf("/");
    const parent = ensureDir(idx === -1 ? "" : f.path.slice(0, idx));
    parent.children.push({
      name: f.path.slice(idx + 1),
      path: f.path,
      dir: false,
      children: [],
      noteCount: 0,
      mtime: f.mtime,
    });
  }

  const cmp = comparator(sortMode);
  const finalize = (node: TreeNode): TreeNode => {
    for (const child of node.children) {
      if (child.dir) finalize(child);
      node.noteCount += child.dir ? child.noteCount : isVaultMarkdownPath(child.path) ? 1 : 0;
      node.mtime = Math.max(node.mtime, child.mtime);
    }
    node.children.sort(cmp);
    return node;
  };
  return finalize(root);
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

export function flattenTree(root: TreeNode, expanded: Record<string, boolean>): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (node: TreeNode, depth: number) => {
    for (const child of node.children) {
      rows.push({ node: child, depth });
      if (child.dir && expanded[child.path]) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Display name: `.md` never shown. */
export function noteDisplayName(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

/** Parent directory of a vault-relative path; "" for a root-level entry. */
export function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function joinVaultPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Leaf name of a vault-relative path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every directory on the way to `path`, outermost first — what has to be
 *  expanded for a row to be visible. */
export function ancestorDirs(path: string): string[] {
  const out: string[] = [];
  let acc = "";
  for (const seg of path.split("/").slice(0, -1)) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push(acc);
  }
  return out;
}

/** Names of the entries sitting directly inside `dir`. */
export function siblingNames(paths: Iterable<string>, dir: string): string[] {
  const prefix = dir ? `${dir}/` : "";
  const out: string[] = [];
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest && !rest.includes("/")) out.push(rest);
  }
  return out;
}

/**
 * How a rename splits an entry's name: `stem` is what the input starts with and
 * the user edits, `suffix` is what gets re-attached on commit. Only markdown
 * files hide their extension — an asset or a folder is edited whole, so typing
 * over it can't silently change what the file is.
 */
export function splitEntryName(path: string, dir: boolean): { stem: string; suffix: string } {
  const name = baseName(path);
  if (dir || !isVaultMarkdownPath(name)) return { stem: name, suffix: "" };
  const stem = noteDisplayName(name);
  return { stem, suffix: name.slice(stem.length) };
}

/** First free "Untitled", "Untitled 2", … among `siblings` (full names). */
export function nextUntitledName(siblings: Iterable<string>, base: string, ext = ""): string {
  const taken = new Set<string>();
  for (const s of siblings) taken.add(s.toLowerCase());
  for (let n = 1; ; n++) {
    const name = `${n === 1 ? base : `${base} ${n}`}${ext}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * Why the typed name can't be committed, or null when it can. `currentName` is
 * excluded from the collision check so a case-only rename ("notes" → "Notes")
 * isn't reported as a clash with itself.
 */
export function renameError(
  input: string,
  suffix: string,
  siblings: Iterable<string>,
  currentName: string,
): string | null {
  const stem = input.trim();
  if (!stem) return "Name can't be empty";
  if (stem.includes("/") || stem.includes("\\")) return "Name can't contain a slash";
  if (stem === "." || stem === "..") return `"${stem}" isn't a usable name`;
  if (isVaultIgnoredPath(stem)) return `"${stem}" is reserved`;
  const target = `${stem}${suffix}`;
  for (const s of siblings) {
    if (s !== currentName && s.toLowerCase() === target.toLowerCase()) return `"${target}" already exists here`;
  }
  return null;
}

/** Path→path moves a rename implies: the entry itself, plus every descendant
 *  when it's a folder (the daemon renames the directory in one move; the store
 *  has to rewrite the keys underneath it). */
export function renameMoves(paths: Iterable<string>, path: string, to: string): [string, string][] {
  const moves: [string, string][] = [[path, to]];
  const prefix = `${path}/`;
  for (const p of paths) {
    if (p.startsWith(prefix)) moves.push([p, to + p.slice(path.length)]);
  }
  return moves;
}
