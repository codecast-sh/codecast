// The changed files of a diff as a folder tree: the shared path prefix taken
// off, folders first, single child folder chains folded into one row.
import type { DiffFile } from "../components/FileDiffLayout";

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[];
  file?: DiffFile;
}

export function shortenPrefix(prefix: string): string {
  if (!prefix) return prefix;
  const parts = prefix.split("/").filter(Boolean);
  // Detect home-dir-relative paths: /Users/x/src/project/... or /home/x/...
  // Show from the first directory after common base dirs (Users/x, home/x, etc.)
  const homeIdx = parts.findIndex(p => p === "Users" || p === "home");
  if (homeIdx >= 0) {
    // Skip Users/<name> or home/<name>, then show from next meaningful dir
    const startAfterHome = homeIdx + 2;
    if (startAfterHome < parts.length) {
      return parts.slice(startAfterHome).join("/");
    }
  }
  // For other absolute paths, just drop the leading slash structure
  // and show last 3-4 meaningful segments
  if (parts.length > 4) {
    return parts.slice(-4).join("/");
  }
  return parts.join("/");
}

export function findCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) {
    const parts = paths[0].split("/");
    return parts.slice(0, -1).join("/");
  }

  const splitPaths = paths.map(p => p.split("/"));
  const minLen = Math.min(...splitPaths.map(p => p.length));

  let commonParts: string[] = [];
  for (let i = 0; i < minLen - 1; i++) {
    const part = splitPaths[0][i];
    if (splitPaths.every(p => p[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  return commonParts.join("/");
}

export function stripCommonPrefix(files: DiffFile[]): DiffFile[] {
  const prefix = findCommonPrefix(files.map(f => f.filename));
  if (!prefix) return files;

  const prefixWithSlash = prefix + "/";
  return files.map(f => ({
    ...f,
    originalFilename: f.originalFilename ?? f.filename,
    filename: f.filename.startsWith(prefixWithSlash)
      ? f.filename.slice(prefixWithSlash.length)
      : f.filename
  }));
}

export function buildFileTreeFromStripped(files: DiffFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.filename.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");

      let node = current.find((n) => n.name === part);

      if (!node) {
        node = {
          name: part,
          path,
          isDirectory: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.push(node);
      }

      if (!isLast) {
        current = node.children;
      }
    }
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    return nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  };

  const sortRecursive = (nodes: FileTreeNode[]): FileTreeNode[] => {
    const sorted = sortNodes(nodes);
    for (const node of sorted) {
      if (node.children.length > 0) {
        node.children = sortRecursive(node.children);
      }
    }
    return sorted;
  };

  return compactChains(sortRecursive(root));
}

/** The files in the order the tree lists them, so the page reads top to
 *  bottom the way the tree does. */
export function treeOrder(files: DiffFile[]): DiffFile[] {
  const out: DiffFile[] = [];
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.file) out.push(node.file);
      walk(node.children);
    }
  };
  walk(buildFileTreeFromStripped(files));
  return out;
}

/** A folder holding nothing but one other folder reads as one row
 *  (`backend/scripts/eval`), so a deep path costs one line, not one per level. */
function compactChains(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (!node.isDirectory) return node;
    let merged = node;
    while (merged.children.length === 1 && merged.children[0].isDirectory) {
      const only = merged.children[0];
      merged = { ...only, name: `${merged.name}/${only.name}` };
    }
    return { ...merged, children: compactChains(merged.children) };
  });
}
