// Bookmarks pane: the vault's pinned list — notes, folders, headings and saved
// searches. A row does what its target is: a note opens, a folder reveals in
// the explorer, a heading opens its note and scrolls to that exact occurrence,
// a saved search switches the left pane to Search and types itself in.
//
// The list itself (order, dedupe, labels, following renames) lives in
// lib/vault/bookmarks + bookmarksHost; this file only arranges and paints it.

import { memo, useState } from "react";
import { Bookmark, BookmarkCheck, Folder, Hash, Search, Trash2, FileText, Pencil } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  bookmarkLabel,
  bookmarkSubtitle,
  defaultBookmarkLabel,
  isBookmarked,
  type BookmarkInput,
  type BookmarkItem,
} from "../../lib/vault/bookmarks";
import { useVaultBookmarks } from "../../lib/vault/bookmarksHost";
import { useVaultStore } from "../../store/vaultStore";
import { scrollToHeadingSlug } from "./useVaultLinkCtx";

function kindIcon(item: BookmarkItem) {
  switch (item.kind) {
    case "folder":
      return <Folder className="w-3.5 h-3.5" />;
    case "heading":
      return <Hash className="w-3.5 h-3.5" />;
    case "search":
      return <Search className="w-3.5 h-3.5" />;
    default:
      return <FileText className="w-3.5 h-3.5" />;
  }
}

/** The row label while renaming — the explorer's rename ergonomics: starts
 *  from what's on screen, Enter commits, Escape abandons, click-away commits. */
function TitleInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      spellCheck={false}
      aria-label="Bookmark name"
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value)}
      className="flex-1 min-w-0 bg-sol-bg text-sol-text text-[12px] px-1 py-0 rounded-sm border border-sol-cyan outline-none"
    />
  );
}

function EmptyState() {
  return (
    <div className="px-3 py-5 text-[11px] leading-5 text-sol-text-dim">
      <div className="text-sol-text-muted mb-2">Nothing bookmarked yet.</div>
      <div className="mb-1">Four things can be pinned here:</div>
      <ul className="space-y-1">
        <li>
          <span className="text-sol-text-muted">Notes</span> — the bookmark icon beside a note&apos;s
          title
        </li>
        <li>
          <span className="text-sol-text-muted">Files and folders</span> — right-click a row in the
          explorer
        </li>
        <li>
          <span className="text-sol-text-muted">Headings</span> — the bookmark icon on an outline row
        </li>
        <li>
          <span className="text-sol-text-muted">Searches</span> — &ldquo;Bookmark this search&rdquo;
          in the search pane
        </li>
      </ul>
    </div>
  );
}

export const VaultBookmarksPane = memo(function VaultBookmarksPane({
  activePath,
  onNavigate,
}: {
  activePath: string | null;
  onNavigate: (path: string) => void;
}) {
  const bookmarks = useVaultBookmarks();
  const removeBookmark = useVaultStore((s) => s.removeBookmark);
  const setBookmarkTitle = useVaultStore((s) => s.setBookmarkTitle);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: BookmarkItem } | null>(null);

  if (!bookmarks.length) return <EmptyState />;

  const open = (item: BookmarkItem) => {
    const store = useVaultStore.getState();
    switch (item.kind) {
      case "folder":
        store.setLeftPaneTab("files");
        store.requestReveal(item.path);
        return;
      case "search":
        store.openSearch(item.query);
        return;
      case "heading":
        onNavigate(item.path);
        // The note may still be mounting; the same delay heading links use.
        scrollToHeadingSlug(item.slug, item.path === activePath ? 0 : 350);
        return;
      default:
        onNavigate(item.path);
    }
  };

  return (
    <div className="py-1">
      {bookmarks.map((item) => {
        const isActive = item.kind !== "search" && item.path === activePath;
        return (
          <div
            key={item.id}
            className={`group flex items-center gap-1.5 px-3 py-1 text-[12px] ${
              isActive ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
            }`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, item });
            }}
          >
            <span className="flex-shrink-0 opacity-60">{kindIcon(item)}</span>
            {renamingId === item.id ? (
              <TitleInput
                initial={bookmarkLabel(item)}
                onCommit={(title) => {
                  // The target's own name is the fallback: clearing the box, or
                  // typing it back, drops the override instead of freezing it.
                  setBookmarkTitle(item.id, title.trim() === defaultBookmarkLabel(item) ? "" : title);
                  setRenamingId(null);
                }}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => open(item)}
                  onDoubleClick={() => setRenamingId(item.id)}
                  title={bookmarkSubtitle(item)}
                  className="flex-1 min-w-0 text-left truncate hover:text-sol-text"
                >
                  {bookmarkLabel(item)}
                </button>
                <button
                  type="button"
                  aria-label="Remove bookmark"
                  title="Remove bookmark"
                  onClick={() => removeBookmark(item.id)}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-sol-text-dim hover:text-sol-red transition-opacity"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        );
      })}

      {menu && (
        <DropdownMenu open onOpenChange={(o) => !o && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1 }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2} className="min-w-[150px]">
            <DropdownMenuItem
              onSelect={() => {
                setRenamingId(menu.item.id);
                setMenu(null);
              }}
            >
              <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-sol-red focus:text-sol-red"
              onSelect={() => {
                removeBookmark(menu.item.id);
                setMenu(null);
              }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-2" /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
});

/** The toggle used wherever something can be bookmarked (note header, outline
 *  row, search pane). It owns the whole gesture — whether the target is
 *  already pinned, and adding or removing it — so no call site repeats that. */
export function BookmarkToggle({
  target,
  label,
  className = "",
  size = "w-4 h-4",
}: {
  target: BookmarkInput;
  label: string;
  className?: string;
  size?: string;
}) {
  const bookmarks = useVaultBookmarks();
  const toggleBookmark = useVaultStore((s) => s.toggleBookmark);
  const bookmarked = isBookmarked(bookmarks, target);
  return (
    <button
      type="button"
      onClick={() => toggleBookmark(target)}
      aria-pressed={bookmarked}
      title={bookmarked ? `Remove ${label}` : label}
      className={`transition-colors ${
        bookmarked ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
      } ${className}`}
    >
      {bookmarked ? <BookmarkCheck className={size} /> : <Bookmark className={size} />}
    </button>
  );
}
