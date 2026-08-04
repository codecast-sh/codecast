// Vault file explorer: virtualized folder tree over the active vault's file
// table. Obsidian conventions: folders sort before files, `.md` never shown,
// unresolved-into-nothing empty folders still render, active note highlighted.
// Keyboard nav (arrows/j/k/enter) owns its keys via data-owns-keys so single
// letters don't leak to global shortcuts.
//
// File operations (new note/folder, rename, delete) run from a right-click
// menu on a row — or on empty space, which targets the vault root. Renaming is
// inline: the label becomes an input and the store does the move. The tree's
// pure model (shape, order, naming rules) lives in lib/vault/explorerModel.

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Bookmark,
  BookmarkX,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  File,
  Pencil,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { isVaultMarkdownPath, isVaultAssetPath } from "@codecast/shared/contracts";
import { canRevealLocally, fileManagerName, revealVaultPath } from "../../lib/vault/reveal";
import {
  ancestorDirs,
  baseName,
  buildVaultTree,
  flattenTree,
  joinVaultPath,
  noteDisplayName,
  parentDir,
  renameError,
  siblingNames,
  splitEntryName,
  visibleVaultFiles,
  type FlatRow,
  type TreeNode,
} from "../../lib/vault/explorerModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { isBookmarked, type BookmarkInput } from "../../lib/vault/bookmarks";
import { useVaultBookmarks } from "../../lib/vault/bookmarksHost";
import { useVaultStore } from "../../store/vaultStore";

export { noteDisplayName };
export type { TreeNode };

/** How long a primed "Really delete?" stays primed. */
const CONFIRM_DELETE_MS = 3000;

function rowIcon(node: TreeNode, isExpanded: boolean) {
  if (node.dir) return isExpanded ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />;
  if (isVaultMarkdownPath(node.path)) return <FileText className="w-3.5 h-3.5" />;
  if (isVaultAssetPath(node.path)) return <ImageIcon className="w-3.5 h-3.5" />;
  return <File className="w-3.5 h-3.5" />;
}

/** The row label while renaming. Mounted fresh per path (keyed by the caller),
 *  so its draft always starts from the name on screen. Markdown extensions are
 *  hidden here exactly as they are in the label, and re-attached on commit. */
function RenameInput({
  stem,
  suffix,
  siblings,
  currentName,
  onCommit,
  onCancel,
}: {
  stem: string;
  suffix: string;
  siblings: string[];
  currentName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(stem);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const err = renameError(value, suffix, siblings, currentName);
    if (err) {
      setError(err);
      return;
    }
    onCommit(`${value.trim()}${suffix}`);
  };

  return (
    <input
      autoFocus
      spellCheck={false}
      value={value}
      title={error ?? undefined}
      aria-label="New name"
      aria-invalid={!!error}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setValue(e.target.value);
        setError(null);
      }}
      // The tree's j/k/arrow handler sits on the scroll container this input
      // lives in — without this every keystroke would also move the selection.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      // Clicking away accepts a valid name and abandons an invalid one, so a
      // rejected name can never leave the row stuck in edit mode.
      onBlur={() => (renameError(value, suffix, siblings, currentName) ? onCancel() : commit())}
      className={`flex-1 min-w-0 bg-sol-bg text-sol-text text-[13px] px-1 py-0 rounded-sm border outline-none ${
        error ? "border-sol-red" : "border-sol-cyan"
      }`}
    />
  );
}

export const VaultExplorer = memo(function VaultExplorer({
  activePath,
  onOpen,
}: {
  activePath: string | null;
  onOpen: (path: string | null) => void;
}) {
  const files = useVaultStore((s) => s.files);
  const expandedDirs = useVaultStore((s) => s.expandedDirs);
  const sortMode = useVaultStore((s) => s.sortMode);
  const renameTarget = useVaultStore((s) => s.renameTarget);
  const revealTarget = useVaultStore((s) => s.revealTarget);
  const toggleDir = useVaultStore((s) => s.toggleDir);
  const setDirsExpanded = useVaultStore((s) => s.setDirsExpanded);
  const setRenameTarget = useVaultStore((s) => s.setRenameTarget);
  const renamePath = useVaultStore((s) => s.renamePath);
  const deletePath = useVaultStore((s) => s.deletePath);
  const newNote = useVaultStore((s) => s.newNote);
  const newFolder = useVaultStore((s) => s.newFolder);
  const toggleBookmark = useVaultStore((s) => s.toggleBookmark);
  const bookmarks = useVaultBookmarks();

  const showAllFiles = useVaultStore((s) => s.showAllFiles);
  const visible = useMemo(() => visibleVaultFiles(files, showAllFiles), [files, showAllFiles]);
  const tree = useMemo(() => buildVaultTree(visible, sortMode), [visible, sortMode]);
  const rows = useMemo(() => flattenTree(tree, expandedDirs), [tree, expandedDirs]);

  const [focusIndex, setFocusIndex] = useState(-1);
  // `node: null` is the vault root — the menu you get right-clicking empty space.
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Reveal only makes sense for files physically on this machine; a mirrored
  // vault has nothing local to point Finder at.
  const localFiles = useVaultStore((s) => !!s.endpoint && !s.isRemote) && canRevealLocally();
  const fileManager = useMemo(() => fileManagerName(), []);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useWatchEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

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
    const collapsed = ancestorDirs(activePath).filter((a) => !useVaultStore.getState().expandedDirs[a]);
    if (collapsed.length) setDirsExpanded(collapsed, true);
  }, [activePath, setDirsExpanded]);

  useWatchEffect(() => {
    if (!activePath) return;
    const idx = rows.findIndex((r) => r.node.path === activePath);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activePath, rows, virtualizer]);

  // Breadcrumb "reveal in explorer": ancestors were expanded by the store;
  // scroll the row into view once it exists in the flattened model.
  useWatchEffect(() => {
    if (!revealTarget) return;
    const idx = rows.findIndex((r) => r.node.path === revealTarget);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "center" });
      setFocusIndex(idx);
      useVaultStore.getState().clearReveal();
    }
  }, [revealTarget, rows, virtualizer]);

  // A row being renamed has to be mounted for its input to exist, and the
  // virtualizer only mounts what's in view — a note created inside a long
  // folder would otherwise get an invisible rename box.
  useWatchEffect(() => {
    if (!renameTarget) return;
    const idx = rows.findIndex((r) => r.node.path === renameTarget);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [renameTarget, rows, virtualizer]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setConfirmDelete(null);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    scrollRef.current?.focus();
  }, []);

  const activate = useCallback(
    (row: FlatRow) => {
      if (row.node.dir) toggleDir(row.node.path);
      else onOpen(row.node.path);
    },
    [toggleDir, onOpen],
  );

  const commitRename = useCallback(
    async (path: string, name: string) => {
      const to = joinVaultPath(parentDir(path), name);
      setRenameTarget(null);
      if (to === path) return;
      try {
        await renamePath(path, to);
      } catch {
        return; // opError carries the reason; the tree already rolled back.
      }
      // The open note moved out from under the URL — follow it, whether it was
      // renamed itself or carried along inside a renamed folder.
      if (activePath === path) onOpen(to);
      else if (activePath?.startsWith(`${path}/`)) onOpen(to + activePath.slice(path.length));
    },
    [renamePath, setRenameTarget, activePath, onOpen],
  );

  const remove = useCallback(
    async (node: TreeNode) => {
      closeMenu();
      try {
        await deletePath(node.path);
      } catch {
        return;
      }
      if (activePath === node.path || activePath?.startsWith(`${node.path}/`)) onOpen(null);
    },
    [deletePath, closeMenu, activePath, onOpen],
  );

  const create = useCallback(
    async (dir: string, kind: "note" | "folder") => {
      closeMenu();
      const path = kind === "note" ? await newNote(dir) : await newFolder(dir);
      // A new note opens straight away (Obsidian's behaviour); the rename the
      // store armed then renames the note the reader is already looking at.
      if (path && kind === "note") onOpen(path);
    },
    [newNote, newFolder, closeMenu, onOpen],
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
      } else if (e.key === "F2") {
        const row = rows[focusIndex];
        if (row) {
          e.preventDefault();
          setRenameTarget(row.node.path);
        }
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
          const idx = rows.findIndex((r) => r.node.path === parentDir(row.node.path));
          if (idx >= 0) {
            setFocusIndex(idx);
            virtualizer.scrollToIndex(idx, { align: "auto" });
          }
        }
      }
    },
    [rows, focusIndex, activate, expandedDirs, toggleDir, virtualizer, setRenameTarget],
  );

  const menuNode = menu?.node ?? null;
  // Creates land inside the folder that was right-clicked, or in the vault root
  // when the click was on empty space. Files offer no creates.
  const menuDir = menuNode?.dir ? menuNode.path : "";
  // Both kinds of row can be bookmarked; a folder bookmark reveals the folder,
  // a file bookmark opens the note.
  const menuBookmark: BookmarkInput | null = menuNode
    ? { kind: menuNode.dir ? "folder" : "note", path: menuNode.path }
    : null;
  const menuBookmarked = !!menuBookmark && isBookmarked(bookmarks, menuBookmark);
  // Notes, their attachments, and folders can be renamed or trashed. Code is
  // read-only — see the menu items below.
  const menuEditable =
    !!menuNode &&
    (menuNode.dir || isVaultMarkdownPath(menuNode.path) || isVaultAssetPath(menuNode.path));

  return (
    <div
      ref={scrollRef}
      data-owns-keys
      tabIndex={0}
      role="tree"
      aria-label="Files"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, node: null });
      }}
      className="h-full overflow-y-auto overflow-x-hidden outline-none text-[13px] select-none"
    >
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-xs leading-5 text-sol-text-muted text-center">
          No files here yet.
          <div className="mt-1 text-sol-text-dim">
            Right-click here, or use the new note button above, to write the first one.
          </div>
        </div>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            const { node, depth } = row;
            const isActive = node.path === activePath;
            const isFocused = vi.index === focusIndex;
            const isExpanded = node.dir && !!expandedDirs[node.path];
            const isRenaming = node.path === renameTarget;
            const rowClass = `w-full flex items-center gap-1.5 px-2 py-[3px] text-left truncate rounded-sm transition-colors ${
              isActive
                ? "bg-sol-bg-highlight text-sol-text"
                : isFocused
                  ? "bg-sol-bg-alt text-sol-text"
                  : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
            }`;
            const chevron = node.dir ? (
              <ChevronRight className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
            ) : (
              <span className="w-3 flex-shrink-0" />
            );
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFocusIndex(vi.index);
                  setMenu({ x: e.clientX, y: e.clientY, node });
                }}
              >
                {isRenaming ? (
                  <div className={rowClass} style={{ paddingLeft: 8 + depth * 14 }} title={node.path}>
                    {chevron}
                    <span className="flex-shrink-0 opacity-70">{rowIcon(node, isExpanded)}</span>
                    <RenameInput
                      {...splitEntryName(node.path, node.dir)}
                      siblings={siblingNames(Object.keys(files), parentDir(node.path))}
                      currentName={baseName(node.path)}
                      onCommit={(name) => void commitRename(node.path, name)}
                      onCancel={() => setRenameTarget(null)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    title={node.path}
                    onClick={() => {
                      setFocusIndex(vi.index);
                      activate(row);
                    }}
                    className={rowClass}
                    style={{ paddingLeft: 8 + depth * 14 }}
                  >
                    {chevron}
                    <span className="flex-shrink-0 opacity-70">{rowIcon(node, isExpanded)}</span>
                    <span className="truncate">{node.dir ? node.name : noteDisplayName(node.name)}</span>
                    {node.dir && node.noteCount > 0 && (
                      <span className="ml-auto pr-1 text-[10px] text-sol-text-dim tabular-nums">{node.noteCount}</span>
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {menu && (
        <DropdownMenu open onOpenChange={(open) => !open && closeMenu()}>
          {/* Anchored to the cursor: a zero-size trigger parked where the
              right-click landed, so Radix owns placement, click-away and Esc. */}
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1 }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2} className="min-w-[170px]">
            {menuNode && !menuNode.dir && (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    closeMenu();
                    onOpen(menuNode.path);
                  }}
                >
                  <SquareArrowOutUpRight className="w-3.5 h-3.5 mr-2" /> Open
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {(!menuNode || menuNode.dir) && (
              <>
                <DropdownMenuItem onSelect={() => void create(menuDir, "note")}>
                  <FilePlus2 className="w-3.5 h-3.5 mr-2" /> New note
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void create(menuDir, "folder")}>
                  <FolderPlus className="w-3.5 h-3.5 mr-2" /> New folder
                </DropdownMenuItem>
              </>
            )}
            {menuNode && localFiles && (
              <>
                {menuNode.dir && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onSelect={() => {
                    closeMenu();
                    void revealVaultPath(menuNode.path, "reveal").then((err) => {
                      if (err) useVaultStore.setState({ opError: err });
                    });
                  }}
                >
                  <FolderOpen className="w-3.5 h-3.5 mr-2" /> Show in {fileManager}
                </DropdownMenuItem>
                {!menuNode.dir && (
                  <DropdownMenuItem
                    onSelect={() => {
                      closeMenu();
                      void revealVaultPath(menuNode.path, "open").then((err) => {
                        if (err) useVaultStore.setState({ opError: err });
                      });
                    }}
                  >
                    <ExternalLink className="w-3.5 h-3.5 mr-2" /> Open in default app
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() => {
                    closeMenu();
                    void navigator.clipboard?.writeText(menuNode.path).catch(() => {});
                  }}
                >
                  <ClipboardCopy className="w-3.5 h-3.5 mr-2" /> Copy path
                </DropdownMenuItem>
              </>
            )}
            {menuNode && (
              <>
                {menuNode.dir && !localFiles && <DropdownMenuSeparator />}
                {localFiles && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onSelect={() => {
                    closeMenu();
                    if (menuBookmark) toggleBookmark(menuBookmark);
                  }}
                >
                  {menuBookmarked ? (
                    <>
                      <BookmarkX className="w-3.5 h-3.5 mr-2" /> Remove bookmark
                    </>
                  ) : (
                    <>
                      <Bookmark className="w-3.5 h-3.5 mr-2" /> Bookmark
                    </>
                  )}
                </DropdownMenuItem>
                {/* Code files are read-only: a rename or a trash is a write,
                    and the daemon refuses both (vaultServer.handleOp). Not
                    offering them beats offering them and failing. Folders keep
                    theirs — a folder is not a code file. */}
                {menuEditable && (
                  <>
                    <DropdownMenuItem
                      onSelect={() => {
                        closeMenu();
                        setRenameTarget(menuNode.path);
                      }}
                    >
                      <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                    </DropdownMenuItem>
                    {/* Two-step in place of a browser confirm(): the item itself
                        becomes the confirmation, and disarms after a moment. */}
                    <DropdownMenuItem
                      className="text-sol-red focus:text-sol-red"
                      onSelect={(e) => {
                        if (confirmDelete !== menuNode.path) {
                          e.preventDefault();
                          setConfirmDelete(menuNode.path);
                          if (confirmTimer.current) clearTimeout(confirmTimer.current);
                          confirmTimer.current = setTimeout(() => setConfirmDelete(null), CONFIRM_DELETE_MS);
                          return;
                        }
                        void remove(menuNode);
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-2" />
                      {confirmDelete === menuNode.path ? "Really delete?" : "Delete"}
                    </DropdownMenuItem>
                  </>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
});
