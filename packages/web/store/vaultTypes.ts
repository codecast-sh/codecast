// The vault store's types: its state and actions (VaultState) and the shapes
// the vault surface reads off it. vaultStore.ts re-exports the public ones.
import type { ConvexReactClient } from "convex/react";
import type { VaultFileEntry, VaultInfo } from "@codecast/shared/contracts";
import type { LoopbackUnreachableReason } from "../lib/terminal/endpoint";
import type { RemoteVault } from "../lib/vault/remoteMirror";
import type { DailyNoteSettings } from "../lib/vault/dailyNotes";
import type { VaultEndpoint } from "../lib/vault/client";
import type { BookmarkInput, BookmarkItem } from "../lib/vault/bookmarks";
import type { VaultSortMode } from "../lib/vault/explorerModel";

export type VaultConnection =
  | "idle"          // not yet asked
  | "discovering"   // looking for the daemon endpoint
  | "connected"     // WS up, scan complete
  | "cached"        // painting from IDB, daemon unreachable
  | "no-daemon";    // discovery failed and no cache exists

export type VaultRightPanelTab = "backlinks" | "outgoing" | "outline" | "tags" | "bookmarks";

export interface VaultBody {
  content: string;
  mtime: number;
  etag: string;
  /** Bytes the daemon served with this content. The browser's decode drops a
   *  BOM and masks undecodable bytes, so the code editor reads both off this,
   *  never off the scan's row, which can describe a different version. */
  size?: number;
}

/** What a rename did to the links pointing at the renamed file. */
export interface RenameReport {
  /** The rename that produced this, for the strip's wording. */
  path: string;
  filesChanged: number;
  linksRewritten: number;
  /** Links deliberately left alone: the file had changed under the plan, or
   *  its write didn't land. Surfaced rather than swallowed — a silent partial
   *  rewrite is the one outcome nobody can recover from. */
  skipped: number;
}

/** Every way the vault page can fail to reach a machine's files: the shared
 *  endpoint-discovery outcomes plus the ones only the vault routes produce.
 *  Named so the teaching panel can bind to it instead of restating the members
 *  — a new discovery outcome must not be able to drift out of the UI. */

/** Where the forward to a cloud host stands. */
export type HostConnectionState = "connecting" | "connected" | "unreachable";

/** A host link that could not reach its host and opened this machine's
 *  checkout instead: the header offers the host again from that vault. */
export interface HostFallback {
  deviceId: string;
  /** The path on the host the link named. */
  hostAbs: string;
  /** The local vault that opened in its place; absent while the checkout
   *  is still being opened. */
  localVaultId?: string;
}

export interface VaultState {
  connection: VaultConnection;
  /** The ACTIVE vault's daemon: this machine's, or the forward to the cloud
   *  host the vault lives on. Every reader that pairs it with activeVaultId
   *  gets the right machine; requests are routed per vault underneath anyway
   *  (lib/vault/hosts/routes.ts). */
  endpoint: VaultEndpoint | null;
  /** This machine's daemon, whatever vault is open. */
  localEndpoint: VaultEndpoint | null;
  /** Cloud hosts this window has opened a forward to, by device id. The
   *  endpoints themselves live in memory in lib/vault/hosts/routes.ts. */
  hostStates: Record<string, HostConnectionState>;
  hostFallback: HostFallback | null;
  setHostFallback: (fallback: HostFallback | null) => void;
  /** Open (or reuse) the forward to the machine `deviceId`. "local" when it is
   *  this machine; "unreachable" when this machine's daemon cannot forward to
   *  it (not one of its hosts, asleep, no daemon here). */
  connectHost: (deviceId: string) => Promise<"local" | "host" | "unreachable">;
  /** A vault a host's daemon located: joins the list bound to that host, so
   *  every request for it goes there. Never cached across reloads. */
  adoptHostVault: (vault: VaultInfo, deviceId: string) => void;
  vaults: VaultInfo[];
  activeVaultId: string | null;
  /** Vault-relative path → entry, for the active vault. */
  files: Record<string, VaultFileEntry>;
  /** Markdown bodies for the active vault (all .md files are held — vaults are
   *  small text; assets are never fetched into memory). */
  bodies: Record<string, VaultBody>;
  scannedAt: number | null;
  /** Paths currently being (re)fetched, for subtle loading affordances. */
  loadingPaths: Record<string, true>;
  /** A write hit a 409: someone changed the file on disk under us. */
  conflicts: Record<string, VaultBody>;
  /** Vaults mirrored from OTHER machines — read-only projections. Present
   *  alongside local vaults; the surface hides every write affordance for one. */
  remoteVaults: RemoteVault[];
  /** Set while the active vault is a remote mirror rather than local disk. */
  isRemote: boolean;
  /** Why the local daemon couldn't be reached — drives cause-specific guidance
   *  instead of one message that blames the daemon for a browser permission. */
  unreachableReason: LoopbackUnreachableReason;
  /** The underlying failure text, shown verbatim in the teaching state so a
   *  cause we did not anticipate is still diagnosable from the screen. */
  unreachableDetail: string | null;
  openRemoteVault: (vaultId: string) => Promise<void>;
  loadRemoteBody: (path: string) => Promise<void>;
  /** Last failed file operation, for a dismissible strip in the UI. */
  opError: string | null;
  clearOpError: () => void;
  /** A vault the daemon registered on request (client.locateVault) joins the
   *  list at once, so the ?path= flow resolves against it without a second
   *  roots round-trip. */
  adoptVault: (vault: VaultInfo) => void;
  /** Rows a file link opened that the scan does not list (ignored, or past
   *  the entry cap). Kept in `files` across rescans until the vault changes. */
  linkedFiles: Record<string, VaultFileEntry>;
  adoptLinkedFile: (entry: VaultFileEntry) => void;
  /** The row for a path in the active vault, asking the daemon when the file
   *  list lacks it: the list is a scan (capped, rule-filtered, possibly a stale
   *  cached copy), so a missing row is not a missing file. Null when the daemon
   *  says this vault has no such file; undefined when it could not be asked. */
  ensureEntry: (path: string) => Promise<VaultFileEntry | null | undefined>;
  /** What the last rename did to the vault's links, for a dismissible strip.
   *  Transient: never persisted, cleared when the next rename starts. */
  lastRenameReport: RenameReport | null;
  clearRenameReport: () => void;
  /** Explorer expand/collapse state (per active vault, session-lived). */
  expandedDirs: Record<string, boolean>;
  /** Recently opened note paths, most recent first (feeds switcher ranking). */
  recentPaths: string[];
  /** Explorer row order — ephemeral, like the panel tabs below. */
  sortMode: VaultSortMode;
  setSortMode: (mode: VaultSortMode) => void;
  /** Show every file on disk, not just notes and their attachments. Persisted
   *  per vault; the default follows the vault's kind (see readShowAllFiles). */
  showAllFiles: boolean;
  setShowAllFiles: (value: boolean) => void;
  /** List what the repo rules hide — build output, .gitignore names, tool
   *  dot-directories — dimmed and read-only. Persisted per vault, off by
   *  default. Only offered for a repo root (see `isRepo`): a notes folder
   *  hides nothing this could lift. */
  showIgnoredFiles: boolean;
  setShowIgnoredFiles: (value: boolean) => void;
  /** Whether the active vault's root is a git checkout, per the last scan. */
  isRepo: boolean;
  /** Pull a non-markdown file's text on demand. Markdown bodies all arrive with
   *  the scan; code is fetched only when someone opens it. Declines past
   *  `maxBytes` (the preview cap unless the caller, the code editor, says). */
  loadTextBody: (path: string, opts?: { maxBytes?: number }) => Promise<void>;
  /** A version some writer outside the store put on disk (the code editor's
   *  own compare-and-swap save): the body and its etag, and the row's size and
   *  mtime, so the watcher's echo of that write is recognized as ours. */
  adoptBody: (vaultId: string, path: string, body: VaultBody) => void;
  /** Path whose explorer row should be in inline-rename mode. Set by the store
   *  so a freshly created note lands in rename regardless of which surface
   *  (header button, row context menu) created it. */
  renameTarget: string | null;
  setRenameTarget: (path: string | null) => void;

  /** Quick switcher (Cmd+O) visibility — ephemeral UI state. */
  quickSwitchOpen: boolean;
  setQuickSwitchOpen: (open: boolean) => void;
  /** Text the switcher opens with (consumed on open). A deep link that named
   *  a file this vault doesn't have seeds the search with its name, so the
   *  near-misses are one keystroke away instead of a dead end. */
  quickSwitchSeed: string | null;
  openQuickSwitch: (seed?: string) => void;
  /** Left pane tab and the search pane's query, lifted here so a saved-search
   *  bookmark can switch to Search and type its query in for you. */
  leftPaneTab: "files" | "search";
  setLeftPaneTab: (tab: "files" | "search") => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  openSearch: (query: string) => void;

  /** Bookmarks for the active vault, oldest first. Persisted to the vault's
   *  own IndexedDB — a bookmark names a path on THIS machine. */
  bookmarks: BookmarkItem[];
  /** The vault the loaded list belongs to (null while a load is in flight). */
  bookmarksVaultId: string | null;
  loadBookmarks: () => Promise<void>;
  addBookmark: (item: BookmarkInput) => void;
  /** Pin or unpin a target — what every bookmark button in the UI calls. */
  toggleBookmark: (item: BookmarkInput) => void;
  removeBookmark: (id: string) => void;
  setBookmarkTitle: (id: string, title: string) => void;
  /** Follow the vault when paths move or vanish; `resolve` returns the new
   *  path, null to drop the bookmark, or undefined to leave it alone. Driven
   *  by lib/vault/bookmarksHost, which watches the file table. */
  retargetBookmarks: (resolve: (path: string) => string | null | undefined) => void;
  /** Right panel state — lifted so a #tag pill click can open the tag pane. */
  rightPanelTab: VaultRightPanelTab;
  setRightPanelTab: (tab: VaultRightPanelTab) => void;
  /** Whether the backlinks/outline side panel is showing. Closed by default —
   *  most visits are reading, and the panel is a lookup you open on purpose.
   *  Remembered across reloads. */
  rightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  selectedTag: string | null;
  setSelectedTag: (tag: string | null) => void;
  openTagPane: (tag: string) => void;
  /** Bumped by every openTagPane. The Files page opens its side panel on a
   *  bump, whichever state owns it (the store flag, or a split pane's own). */
  tagPaneRequest: number;
  /** One-shot explorer reveal request (breadcrumb click): expand + scroll. */
  revealTarget: string | null;
  requestReveal: (path: string) => void;
  clearReveal: () => void;
  toggleDir: (path: string) => void;
  setDirsExpanded: (paths: string[], expanded: boolean) => void;
  noteOpened: (path: string) => void;
  connect: (convex: ConvexReactClient, opts?: { force?: boolean }) => Promise<void>;
  selectVault: (vaultId: string) => Promise<void>;
  refresh: () => Promise<void>;
  writeFile: (path: string, content: string, baseEtag?: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
  /** Moves an entry; a folder carries its whole subtree with it. */
  renamePath: (path: string, to: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  /** Create an "Untitled" note / "New folder" inside `dir` ("" = vault root),
   *  reveal it, and put it in inline rename. Resolves to the created path, or
   *  null when the daemon refused (opError carries the reason). */
  newNote: (dir: string) => Promise<string | null>;
  /** Daily notes: settings live per vault in the prefs table; the defaults are
   *  Obsidian's (a "Daily" folder, ISO date names). */
  dailySettings: DailyNoteSettings;
  setDailySettings: (next: Partial<DailyNoteSettings>) => void;
  /** Open (creating if needed) the note for a date — today by default. */
  openDailyNote: (date?: Date) => Promise<string | null>;
  /** Nearest EXISTING daily note before/after the given date, or null. */
  adjacentDaily: (date: Date, direction: -1 | 1) => string | null;
  newFolder: (dir: string) => Promise<string | null>;
  resolveConflictWithDisk: (path: string) => void;
  resolveConflictKeepMine: (path: string) => Promise<void>;
}
