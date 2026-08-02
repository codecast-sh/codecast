// Bookmarks: the vault's pinned list — notes, folders, headings and saved
// searches, in the order they were added.
//
// Everything here is pure so the store and the IndexedDB layer only carry the
// list around. Identity is the TARGET, not the row: bookmarking the same note
// twice is a no-op rather than a second row, which is also what makes the note
// header's toggle a toggle. A row's `title` is only ever a user's override —
// the label falls back to the target's own name, so renaming a note renames
// its bookmark for free.

import { noteDisplayName } from "./explorerModel";

export type BookmarkKind = "note" | "folder" | "heading" | "search";

interface BookmarkFields {
  id: string;
  /** User-set label; absent means "show the target's own name". */
  title?: string;
  createdAt: number;
}

export interface NoteBookmark extends BookmarkFields {
  kind: "note";
  path: string;
}
export interface FolderBookmark extends BookmarkFields {
  kind: "folder";
  path: string;
}
export interface HeadingBookmark extends BookmarkFields {
  kind: "heading";
  path: string;
  headingText: string;
  /** Deduped anchor slug (headingSlugs), so the jump lands on the right
   *  occurrence when a note repeats a heading. */
  slug: string;
}
export interface SearchBookmark extends BookmarkFields {
  kind: "search";
  query: string;
}

export type BookmarkItem = NoteBookmark | FolderBookmark | HeadingBookmark | SearchBookmark;

/** What a caller asks for; the store stamps id and createdAt. */
export type BookmarkInput =
  | Omit<NoteBookmark, "id" | "createdAt">
  | Omit<FolderBookmark, "id" | "createdAt">
  | Omit<HeadingBookmark, "id" | "createdAt">
  | Omit<SearchBookmark, "id" | "createdAt">;

/** A bookmark's target, for dedupe and for "is this already bookmarked?". */
export function bookmarkKey(item: BookmarkInput): string {
  switch (item.kind) {
    case "search":
      return `search:${item.query.trim()}`;
    case "heading":
      return `heading:${item.path}#${item.slug}`;
    default:
      return `${item.kind}:${item.path}`;
  }
}

/** The path a bookmark points at, or null for a saved search. */
export function bookmarkPath(item: BookmarkItem): string | null {
  return item.kind === "search" ? null : item.path;
}

/** The row's label: the user's title when they set one, else the target's own
 *  name (so renaming a note renames its bookmark). */
export function bookmarkLabel(item: BookmarkItem): string {
  return item.title?.trim() || defaultBookmarkLabel(item);
}

/** The target's own name, ignoring any user title. A folder bookmark on the
 *  vault root has no basename to show. */
export function defaultBookmarkLabel(item: BookmarkItem): string {
  switch (item.kind) {
    case "search":
      return item.query;
    case "heading":
      return item.headingText;
    case "folder":
      return item.path.split("/").pop() || "Vault root";
    default:
      return noteDisplayName(item.path.split("/").pop() ?? item.path);
  }
}

/** The line under the label: where a bookmark actually goes. */
export function bookmarkSubtitle(item: BookmarkItem): string {
  switch (item.kind) {
    case "search":
      return `Saved search: ${item.query}`;
    case "heading":
      return noteDisplayName(item.path.split("/").pop() ?? item.path);
    default:
      return item.path;
  }
}

export function isBookmarked(list: BookmarkItem[], target: BookmarkInput): boolean {
  const key = bookmarkKey(target);
  return list.some((b) => bookmarkKey(b) === key);
}

export function findBookmark(list: BookmarkItem[], target: BookmarkInput): BookmarkItem | null {
  const key = bookmarkKey(target);
  return list.find((b) => bookmarkKey(b) === key) ?? null;
}

/** Append unless the same target is already bookmarked. Returns the SAME array
 *  when nothing changed, so the store can skip the write. */
export function addBookmark(list: BookmarkItem[], item: BookmarkItem): BookmarkItem[] {
  return isBookmarked(list, item) ? list : [...list, item];
}

export function removeBookmark(list: BookmarkItem[], id: string): BookmarkItem[] {
  const next = list.filter((b) => b.id !== id);
  return next.length === list.length ? list : next;
}

/** Set (or, with an empty string, clear) a row's user title. */
export function retitleBookmark(list: BookmarkItem[], id: string, title: string): BookmarkItem[] {
  const trimmed = title.trim();
  let changed = false;
  const next = list.map((b) => {
    if (b.id !== id || (b.title ?? "") === trimmed) return b;
    changed = true;
    const { title: _old, ...rest } = b;
    return (trimmed ? { ...rest, title: trimmed } : rest) as BookmarkItem;
  });
  return changed ? next : list;
}

/**
 * Follow the vault: `resolve` answers, for a path that left the file table,
 * where it went — a new path, or null when it's gone for good. Bookmarks whose
 * path is untouched are left alone (and the array identity is preserved when
 * nothing at all changed).
 */
export function retargetBookmarks(
  list: BookmarkItem[],
  resolve: (path: string) => string | null | undefined,
): BookmarkItem[] {
  let changed = false;
  const next: BookmarkItem[] = [];
  for (const b of list) {
    const path = bookmarkPath(b);
    if (path === null) {
      next.push(b);
      continue;
    }
    const moved = resolve(path);
    if (moved === undefined) {
      next.push(b);
      continue;
    }
    changed = true;
    if (moved === null) continue; // deleted — the bookmark goes with it
    next.push({ ...b, path: moved } as BookmarkItem);
  }
  return changed ? next : list;
}

/** Oldest first: the list reads as the order things were added, and a new
 *  bookmark always lands at the bottom where the user just put it. */
export function sortBookmarks(list: BookmarkItem[]): BookmarkItem[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt);
}
