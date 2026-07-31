// Vault file explorer: virtualized folder tree over the active vault's file
// table. Obsidian conventions: folders sort before files, `.md` never shown,
// unresolved-into-nothing empty folders still render, active note highlighted.
// Keyboard nav (arrows/j/k/enter) owns its keys via data-owns-keys so single
// letters don't leak to global shortcuts.

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, FileText, Folder, FolderOpen, Image as ImageIcon, File } from "lucide-react";
import { isVaultMarkdownPath, isVaultAssetPath, type VaultFileEntry } from "@codecast/shared/contracts";
import { useVaultStore } from "../../store/vaultStore";

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
  noteCount: number;
}

export function buildVaultTree(files: Record<string, VaultFileEntry>): TreeNode {
  const root: TreeNode = { name: "", path: "", dir: true, children: [], noteCount: 0 };
  const dirNodes = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirNodes.get(path);
    if (existing) return existing;
    const idx = path.lastIndexOf("/");
    const parent = ensureDir(idx === -1 ? "" : path.slice(0, idx));
    const node: TreeNode = { name: path.slice(idx + 1), path, dir: true, children: [], noteCount: 0 };
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
    parent.children.push({ name: f.path.slice(idx + 1), path: f.path, dir: false, children: [], noteCount: 0 });
  }

  const finalize = (node: TreeNode): number => {
    node.children.sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    );
    node.noteCount = node.children.reduce(
      (acc, c) => acc + (c.dir ? finalize(c) : isVaultMarkdownPath(c.path) ? 1 : 0),
      0,
    );
    return node.noteCount;
  };
  finalize(root);
  return root;
}

interface FlatRow {
  node: TreeNode;
  depth: number;
}

function flattenTree(root: TreeNode, expanded: Record<string, boolean>): FlatRow[] {
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

function rowIcon(node: TreeNode, isExpanded: boolean) {
  if (node.dir) return isExpanded ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />;
  if (isVaultMarkdownPath(node.path)) return <FileText className="w-3.5 h-3.5" />;
  if (isVaultAssetPath(node.path)) return <ImageIcon className="w-3.5 h-3.5" />;
  return <File className="w-3.5 h-3.5" />;
}

export const VaultExplorer = memo(function VaultExplorer({
  activePath,
  onOpen,
}: {
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const files = useVaultStore((s) => s.files);
  const expandedDirs = useVaultStore((s) => s.expandedDirs);
  const toggleDir = useVaultStore((s) => s.toggleDir);
  const setDirsExpanded = useVaultStore((s) => s.setDirsExpanded);

  const tree = useMemo(() => buildVaultTree(files), [files]);
  const rows = useMemo(() => flattenTree(tree, expandedDirs), [tree, expandedDirs]);

  const [focusIndex, setFocusIndex] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    getItemKey: (i) => rows[i]?.node.path ?? i,
    overscan: 12,
  });

  // Reveal the active note: expand its ancestors and scroll it into view when
  // it changes from outside (quick switcher, wiki link click).
  useWatchEffect(() => {
    if (!activePath) return;
    const segments = activePath.split("/").slice(0, -1);
    const ancestors: string[] = [];
    let acc = "";
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      ancestors.push(acc);
    }
    const collapsed = ancestors.filter((a) => !useVaultStore.getState().expandedDirs[a]);
    if (collapsed.length) setDirsExpanded(collapsed, true);
  }, [activePath, setDirsExpanded]);

  useWatchEffect(() => {
    if (!activePath) return;
    const idx = rows.findIndex((r) => r.node.path === activePath);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activePath, rows, virtualizer]);

  const activate = useCallback(
    (row: FlatRow) => {
      if (row.node.dir) toggleDir(row.node.path);
      else onOpen(row.node.path);
    },
    [toggleDir, onOpen],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const move = (delta: number) => {
        e.preventDefault();
        setFocusIndex((i) => {
          const next = Math.max(0, Math.min(rows.length - 1, (i === -1 ? 0 : i) + delta));
          virtualizer.scrollToIndex(next, { align: "auto" });
          return next;
        });
      };
      if (e.key === "ArrowDown" || e.key === "j") move(1);
      else if (e.key === "ArrowUp" || e.key === "k") move(-1);
      else if (e.key === "Enter") {
        const row = rows[focusIndex];
        if (row) activate(row);
      } else if (e.key === "ArrowRight") {
        const row = rows[focusIndex];
        if (row?.node.dir && !expandedDirs[row.node.path]) {
          e.preventDefault();
          toggleDir(row.node.path);
        }
      } else if (e.key === "ArrowLeft") {
        const row = rows[focusIndex];
        if (!row) return;
        e.preventDefault();
        if (row.node.dir && expandedDirs[row.node.path]) toggleDir(row.node.path);
        else {
          // Jump to parent folder.
          const parent = row.node.path.slice(0, row.node.path.lastIndexOf("/"));
          const idx = rows.findIndex((r) => r.node.path === parent);
          if (idx >= 0) {
            setFocusIndex(idx);
            virtualizer.scrollToIndex(idx, { align: "auto" });
          }
        }
      }
    },
    [rows, focusIndex, activate, expandedDirs, toggleDir, virtualizer],
  );

  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 text-xs text-sol-text-muted text-center">
        No files in this vault yet.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-owns-keys
      tabIndex={0}
      role="tree"
      aria-label="Vault files"
      onKeyDown={onKeyDown}
      className="h-full overflow-y-auto overflow-x-hidden outline-none text-[13px] select-none"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          const { node, depth } = row;
          const isActive = node.path === activePath;
          const isFocused = vi.index === focusIndex;
          const isExpanded = node.dir && !!expandedDirs[node.path];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
            >
              <button
                type="button"
                title={node.path}
                onClick={() => {
                  setFocusIndex(vi.index);
                  activate(row);
                }}
                className={`w-full flex items-center gap-1.5 px-2 py-[3px] text-left truncate rounded-sm transition-colors ${
                  isActive
                    ? "bg-sol-bg-highlight text-sol-text"
                    : isFocused
                      ? "bg-sol-bg-alt text-sol-text"
                      : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
                }`}
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                {node.dir ? (
                  <ChevronRight
                    className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                  />
                ) : (
                  <span className="w-3 flex-shrink-0" />
                )}
                <span className="flex-shrink-0 opacity-70">{rowIcon(node, isExpanded)}</span>
                <span className="truncate">{node.dir ? node.name : noteDisplayName(node.name)}</span>
                {node.dir && node.noteCount > 0 && (
                  <span className="ml-auto pr-1 text-[10px] text-sol-text-dim tabular-nums">{node.noteCount}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
