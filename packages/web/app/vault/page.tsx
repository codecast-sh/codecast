"use client";
// /files — Obsidian-style browsing of a connected local directory. The daemon's
// loopback bridge serves the files; selection is URL-driven (?f=<vault-relative
// path>) so history, tabs, and deep links all work.
//
// The surface is called "Files" and lives at /files; /vault is its permanent
// pre-rename alias (see lib/vault/vaultHref.ts). Internal names, the store, the
// daemon routes and the `cast vault` command group keep the vault vocabulary —
// only the label and the canonical route changed.

import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvex } from "convex/react";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import {
  ArrowUpDown,
  Cloud,
  CopyMinus,
  FilePlus2,
  FolderPlus,
  FileCode2,
  FolderTree,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  RefreshCw,
  Search,
  Waypoints,
  WifiOff,
  X,
} from "lucide-react";
import { isVaultAssetPath, isVaultMarkdownPath } from "@codecast/shared/contracts";
import { AuthGuard } from "../../components/AuthGuard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { VAULT_SORT_OPTIONS, ancestorDirs, type VaultSortMode } from "../../lib/vault/explorerModel";
import { useTabContext } from "../../lib/tabParams";
import { useShortcutAction } from "../../shortcuts";
import { VaultExplorer } from "../../components/vault/VaultExplorer";
import { VaultNoteView } from "../../components/vault/VaultNoteView";
import { VaultFileView } from "../../components/vault/VaultFileView";
import { VaultRightPanel } from "../../components/vault/VaultRightPanel";
import { VaultFindBar } from "../../components/vault/VaultFindBar";
import { HoverPreviewProvider } from "../../components/vault/VaultHoverPreview";
import { VaultSearchPane } from "../../components/vault/VaultSearchPane";
import { VaultPicker } from "../../components/vault/VaultPicker";
import { VaultScopeLine } from "../../components/vault/VaultScopeLine";
import { useDocForFile, useVaultTeamResolver } from "../../components/vault/useVaultScope";
import { vaultPresence } from "../../lib/vault/scopeModel";
import { vaultLandingPath } from "../../lib/vault/projectVault";
import { filesHref, resolveVaultTarget } from "../../lib/vault/vaultHref";
import { useVaultStore, type VaultUnreachableReason } from "../../store/vaultStore";
import {
  toggleVaultEditMode,
  toggleVaultSourceMode,
  vaultViewMode,
  setVaultModeScope,
  type VaultViewMode,
} from "../../lib/vault/viewMode";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { isElectron } from "../../lib/desktop";

// sigma + graphology are ~40kB gzip: nobody who doesn't open the graph pays.
const VaultGraphView = lazy(() =>
  import("../../components/vault/VaultGraphView").then((m) => ({ default: m.VaultGraphView })),
);

const headerButtonClass = "text-sol-text-dim hover:text-sol-text transition-colors";

const SIDE_MIN_PX = 200;

const separatorClass =
  "relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

function EmptyVaultTeaching() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
      <FolderTree className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">Nothing to browse yet</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        Your projects show up here on their own, as soon as one of them has a
        README or a docs folder. To browse a folder of notes that isn&apos;t a
        project, point the CLI at it:
      </div>
      <pre className="text-[13px] bg-sol-bg-alt border border-sol-border/30 rounded px-4 py-2 text-sol-text">
        cast vault add ~/notes
      </pre>
      <div className="text-xs text-sol-text-dim max-w-md">
        Files stay on your machine — the browser reads them directly from the
        local daemon.
      </div>
    </div>
  );
}

function NoDaemonTeaching({
  reason,
  detail,
  remoteVaults,
  onRetry,
  onOpenRemote,
}: {
  reason: VaultUnreachableReason;
  detail: string | null;
  remoteVaults: { id: string; name: string; note_count?: number }[];
  onRetry: () => void;
  onOpenRemote: (id: string) => void;
}) {
  // One dead end used to answer three different problems. The browser blocking
  // a loopback request looks nothing like a daemon that isn't running, and
  // telling someone to restart a healthy daemon wastes their time.
  // A refused probe has two honest readings, and only one of them exists in
  // the desktop app: there is no browser gate in Electron, so pointing at the
  // address bar there sends people hunting for a permission they cannot grant.
  const desktop = isElectron();
  const copy = {
    "daemon-slow": {
      title: "The daemon is running, but slow to answer",
      body: (
        <>
          It&apos;s registered as live, but didn&apos;t respond within the time limit —
          usually a daemon busy with many sessions or a slow tmux. That is load, not a
          browser problem: retry in a moment, and{" "}
          <code className="text-sol-text">cast doctor</code> shows its health.
        </>
      ),
    },
    "probe-failed": {
      title: desktop ? "No daemon answered on this machine" : "This page can't reach the daemon",
      body: desktop ? (
        <>
          A daemon answered, but not one this app can reach — the files live on another
          machine, or the daemon here isn&apos;t running. Start it with{" "}
          <code className="text-sol-text">cast daemon</code> or check{" "}
          <code className="text-sol-text">cast doctor</code>, then retry.
        </>
      ) : (
        <>
          A daemon answered, but the request to it was refused. Either it runs on another
          machine, or the browser blocked the local connection — Chrome asks permission the
          first time a site connects to your local network; allow it from the address-bar
          icon, then retry.
        </>
      ),
    },
    "no-devices": {
      title: "Can't reach the local daemon",
      body: (
        <>
          Files are read straight from this machine, which needs the codecast daemon
          running. Start it with <code className="text-sol-text">cast daemon</code> or check{" "}
          <code className="text-sol-text">cast doctor</code>. If it IS running, make sure
          you&apos;re signed in as the same account it belongs to.
        </>
      ),
    },
    "old-daemon": {
      title: "This machine's daemon is too old for this",
      body: (
        <>
          It answered, but it doesn&apos;t serve the file routes yet. Run{" "}
          <code className="text-sol-text">cast update</code> and try again.
        </>
      ),
    },
    refused: {
      title: "The daemon refused this request",
      body: (
        <>
          It answered, but turned the request away — usually a stale
          connection token after a restart. Retry; if it persists, restart the
          daemon.
        </>
      ),
    },
    error: {
      title: "The request didn't go through",
      body: (
        <>
          The daemon is running and answered the first check, but the file call
          failed before reaching it. Retry — the detail below says why.
        </>
      ),
    },
    "other-device": {
      title: "Those files are on another machine",
      body: (
        <>
          A vault is read straight off the disk it lives on, so only that machine can
          serve it. Open this page there, or read a mirrored copy below if one exists.
        </>
      ),
    },
    none: {
      title: "Can't reach the local daemon",
      body: (
        <>
          Start it with <code className="text-sol-text">cast daemon</code> or check{" "}
          <code className="text-sol-text">cast doctor</code>.
        </>
      ),
    },
  }[reason];

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
      <WifiOff className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">{copy.title}</div>
      <div className="text-sm text-sol-text-muted max-w-md">{copy.body}</div>
      {detail && (
        <code className="text-[11px] text-sol-text-dim max-w-md break-all">{detail}</code>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="sol-btn text-xs px-3 py-1.5 mt-1"
      >
        Retry connection
      </button>
      {remoteVaults.length > 0 && (
        <div className="mt-4 pt-3 border-t border-sol-border/30 max-w-md">
          <div className="text-[11px] uppercase tracking-wide text-sol-text-dim mb-1.5">
            Mirrored from another machine
          </div>
          {remoteVaults.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onOpenRemote(v.id)}
              className="block w-full text-left px-2 py-1 text-[13px] text-sol-cyan hover:bg-sol-bg-alt rounded"
            >
              {v.name}
              {v.note_count ? (
                <span className="text-sol-text-dim text-[11px]"> — {v.note_count} notes, read-only</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LEFT_TABS: { id: "files" | "search"; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "files", label: "Files", icon: FolderTree },
  { id: "search", label: "Search", icon: Search },
];

function VaultContent() {
  const convex = useConvex();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const connection = useVaultStore((s) => s.connection);
  const vaults = useVaultStore((s) => s.vaults);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const connect = useVaultStore((s) => s.connect);
  const selectVault = useVaultStore((s) => s.selectVault);
  const remoteVaults = useVaultStore((s) => s.remoteVaults);
  const openRemoteVault = useVaultStore((s) => s.openRemoteVault);
  const isRemote = useVaultStore((s) => s.isRemote);
  const unreachableReason = useVaultStore((s) => s.unreachableReason);
  const unreachableDetail = useVaultStore((s) => s.unreachableDetail);
  const refresh = useVaultStore((s) => s.refresh);
  const noteOpened = useVaultStore((s) => s.noteOpened);
  const sortMode = useVaultStore((s) => s.sortMode);
  const setSortMode = useVaultStore((s) => s.setSortMode);
  const newNote = useVaultStore((s) => s.newNote);
  const newFolder = useVaultStore((s) => s.newFolder);
  const setDirsExpanded = useVaultStore((s) => s.setDirsExpanded);
  const opError = useVaultStore((s) => s.opError);
  const clearOpError = useVaultStore((s) => s.clearOpError);
  const renameReport = useVaultStore((s) => s.lastRenameReport);
  const clearRenameReport = useVaultStore((s) => s.clearRenameReport);
  const showAllFiles = useVaultStore((s) => s.showAllFiles);
  const setShowAllFiles = useVaultStore((s) => s.setShowAllFiles);

  const activePath = searchParams.get("f");
  // A local path as written somewhere else — a conversation, a CLI link —
  // rather than vault-relative. Resolved below once the vault list is in.
  const localPath = searchParams.get("path");
  const targetLineRaw = searchParams.get("l");
  const targetLine = targetLineRaw ? parseInt(targetLineRaw, 10) : undefined;
  const showGraph = searchParams.get("view") === "graph";

  // The side panel (backlinks / outline / tags) is closed by default and
  // toggled from a button in the content pane. The store flag is the truth;
  // this effect drives the resizable panel to match it. Expanding resizes to
  // an explicit width rather than calling expand(): the library's restored
  // size can land below the collapse midpoint and clamp straight back to 0.
  const rightPanelOpen = useVaultStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useVaultStore((s) => s.setRightPanelOpen);
  const sidePanelRef = usePanelRef();
  const sideAppliedRef = useRef<boolean | null>(null);
  useWatchEffect(() => {
    const ref = sidePanelRef.current;
    if (!ref || showGraph) return;
    if (sideAppliedRef.current === rightPanelOpen) return;
    const firstSync = sideAppliedRef.current === null;
    sideAppliedRef.current = rightPanelOpen;
    if (firstSync && ref.isCollapsed() !== rightPanelOpen) return;
    if (!rightPanelOpen) {
      ref.collapse();
      return;
    }
    ref.resize("22%");
    // A narrow window: 22% can fall under the panel's pixel minimum and the
    // library silently refuses. Ask for the minimum itself, and if that can't
    // fit either, put the flag back so the button never claims an open panel.
    requestAnimationFrame(() => {
      if (!ref.isCollapsed()) return;
      ref.resize(`${SIDE_MIN_PX}px`);
      requestAnimationFrame(() => {
        if (ref.isCollapsed()) {
          sideAppliedRef.current = false;
          setRightPanelOpen(false);
        }
      });
    });
    // `connection` is a dep because the panel group only mounts once the vault
    // is reachable; before that the ref is empty and the effect must retry.
  }, [rightPanelOpen, showGraph, connection]);
  // The explorer column costs ~200px that a narrow pane can't spare — Files
  // opened beside a conversation, mostly. Local state, decided by the pane's
  // own width at first layout: a narrow split starts with the tree hidden, a
  // full tab shows it. The toggles live in the tree titlebar (hide) and the
  // content pane's top-left corner (show).
  const treePanelRef = usePanelRef();
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Below this width the explorer column and the content can no longer share
  // the pane (their pixel minimums do not fit), so the tree renders as an
  // overlay drawer instead of a split — and starts hidden. Typical case:
  // Files opened beside a conversation.
  // null until the first measure: the split panel only mounts once the pane
  // is known to be wide enough — mounting it into a pane that cannot satisfy
  // its pixel minimums livelocks the panel library.
  const [paneNarrow, setPaneNarrow] = useState<boolean | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const treeAppliedRef = useRef<boolean | null>(null);
  const treeExpandingRef = useRef(false);
  const firstMeasureRef = useRef(true);
  useWatchEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const narrow = el.offsetWidth < 640;
      if (firstMeasureRef.current) {
        firstMeasureRef.current = false;
        if (narrow) setTreeOpen(false);
      }
      setPaneNarrow((prev) => {
        if (prev !== narrow) treeAppliedRef.current = null;
        return narrow;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [connection]);
  // Mirror treeOpen onto the split panel (wide layout only; the overlay
  // renders from state directly).
  useWatchEffect(() => {
    if (paneNarrow !== false) return;
    const ref = treePanelRef.current;
    if (!ref) return;
    if (treeAppliedRef.current === treeOpen) return;
    const firstSync = treeAppliedRef.current === null;
    treeAppliedRef.current = treeOpen;
    if (!treeOpen) {
      ref.collapse();
      return;
    }
    if (firstSync) return; // the panel mounts expanded already
    treeExpandingRef.current = true;
    ref.resize("20%");
    // 20% of a modest pane can fall under the pixel minimum and the library
    // collapses instead of resizing; ask for the minimum itself on the retry.
    requestAnimationFrame(() => {
      if (treePanelRef.current?.isCollapsed()) treePanelRef.current.resize("180px");
      requestAnimationFrame(() => {
        treeExpandingRef.current = false;
      });
    });
  }, [treeOpen, paneNarrow, connection]);
  // Picking a file from the overlay closes it — on a narrow pane the reader
  // is the point, and the drawer covers most of it.
  useWatchEffect(() => {
    if (paneNarrow) setTreeOpen(false);
  }, [activePath, paneNarrow]);
  const leftTab = useVaultStore((s) => s.leftPaneTab);
  const setLeftTab = useVaultStore((s) => s.setLeftPaneTab);

  useWatchEffect(() => {
    if (connection === "idle") void connect(convex);
  }, [connection, connect, convex]);

  // ?path=<local path> → pick the vault whose root contains it, then rewrite
  // the URL to the ordinary ?f= form (replace, so Back skips the redirect).
  // A file opens; a directory expands in the tree with nothing selected. The
  // effect re-runs as each prerequisite lands: the vault list, the selected
  // vault, its file table.
  const scannedAtForPath = useVaultStore((s) => s.scannedAt);
  useWatchEffect(() => {
    if (!localPath) return;
    if (connection !== "connected" && connection !== "cached") return;
    const store = useVaultStore.getState();
    const activeRoot = vaults.find((v) => v.id === activeVaultId)?.root;
    const target = resolveVaultTarget(localPath, vaults, activeRoot);
    if (!target) {
      useVaultStore.setState({
        opError: `No vault on this machine contains ${localPath}. Add one with \`cast vault add <dir>\`.`,
      });
      router.replace(filesHref());
      return;
    }
    if (target.vaultId !== activeVaultId) {
      void selectVault(target.vaultId);
      return;
    }
    if (!scannedAtForPath) return;
    if (store.opError) store.clearOpError(); // a stale "no vault contains…" from an earlier link
    const { files } = store;
    let rel = target.rel;
    let entry = rel ? files[rel] : undefined;
    // Agents write paths relative to wherever they were looking — a package
    // dir, not the repo root. When the literal path isn't here but exactly one
    // file ends with it, that is the file they meant.
    if (rel && !entry && !Object.keys(files).some((p) => p.startsWith(`${rel}/`))) {
      const suffix = `/${rel}`;
      const candidates = Object.keys(files).filter((p) => p.endsWith(suffix) && !files[p].dir);
      if (candidates.length === 1) {
        rel = candidates[0];
        entry = files[rel];
      }
    }
    const isDir = !rel || !!entry?.dir || Object.keys(files).some((p) => p.startsWith(`${rel}/`));
    store.setLeftPaneTab("files");
    if (entry && !entry.dir) {
      // A source file in a notes vault sits behind the "all files" toggle;
      // flip it so the tree shows what the link opened.
      if (!store.showAllFiles && !isVaultMarkdownPath(rel) && !isVaultAssetPath(rel)) store.setShowAllFiles(true);
      store.noteOpened(rel);
      store.requestReveal(rel);
      router.replace(filesHref({ path: rel, line: targetLine }));
      return;
    }
    if (isDir) {
      if (rel) store.setDirsExpanded([...ancestorDirs(rel), rel], true);
      router.replace(filesHref());
      return;
    }
    // Nothing by that name: open the nearest directory that does exist, say
    // so, and put the name into the quick switcher — the near-misses (a moved
    // file, a typo in the transcript) are then one keystroke away.
    const existing = ancestorDirs(rel).filter((d) => files[d]?.dir || Object.keys(files).some((p) => p.startsWith(`${d}/`)));
    if (existing.length) store.setDirsExpanded(existing, true);
    useVaultStore.setState({ opError: `${target.abs} isn't in this vault.` });
    store.openQuickSwitch(rel.slice(rel.lastIndexOf("/") + 1));
    router.replace(filesHref());
  }, [localPath, connection, vaults, activeVaultId, scannedAtForPath, selectVault, router, targetLine]);

  // `line` rides along in the URL for search results: the note view doesn't
  // scroll to it yet, but the link already carries where the hit was.
  const openNote = useCallback(
    (path: string | null, line?: number) => {
      if (path) {
        noteOpened(path);
        router.push(filesHref({ path, line }));
      } else {
        router.push(filesHref());
      }
    },
    [router, noteOpened],
  );

  // Header creates land in the vault root; creating inside a folder is the row
  // context menu's job. Either way the store arms the inline rename.
  const createInRoot = useCallback(
    async (kind: "note" | "folder") => {
      setLeftTab("files");
      const path = kind === "note" ? await newNote("") : await newFolder("");
      if (path && kind === "note") openNote(path);
    },
    [newNote, newFolder, openNote, setLeftTab],
  );

  const collapseAll = useCallback(() => {
    const open = Object.entries(useVaultStore.getState().expandedDirs)
      .filter(([, expanded]) => expanded)
      .map(([path]) => path);
    if (open.length) setDirsExpanded(open, false);
  }, [setDirsExpanded]);

  // The graph replaces the reading pane rather than sitting beside it, so it
  // rides in the URL like selection does: ?view=graph keeps the open note in
  // ?f=, which is what the local graph anchors on.
  const toggleGraph = useCallback(() => {
    router.push(filesHref({ path: activePath, graph: !showGraph }));
  }, [router, showGraph, activePath]);

  // Ctrl/Cmd+Shift+F focuses vault search — but only while the vault is the
  // visible tab; declining leaves the chord to the conversation's favorite
  // binding, which shares it.
  const tabCtx = useTabContext();
  const isTabActive = (tabCtx as { isActive?: boolean } | null)?.isActive !== false;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useShortcutAction("vault.search", () => {
    if (!isTabActive) return false;
    setLeftTab("search");
    requestAnimationFrame(() => searchInputRef.current?.select());
    return true;
  });

  const [, bumpEditMode] = useState(0);
  // Mode memory is per vault: scoping it here means a vault switch forgets the
  // previous vault's modes before any note of the new one is asked about.
  setVaultModeScope(activeVaultId);
  const mode = vaultViewMode(activePath);
  // The mode memory is module state, not React state, so the bump is what makes
  // a change visible; both chords go through here.
  const applyMode = useCallback(
    (next: (path: string) => VaultViewMode) => {
      if (!activePath) return false;
      next(activePath);
      bumpEditMode((n) => n + 1);
      return true;
    },
    [activePath],
  );
  const toggleEdit = useCallback(() => applyMode(toggleVaultEditMode), [applyMode]);

  useShortcutAction("vault.toggleEdit", () => {
    if (!isTabActive || showGraph) return false;
    return toggleEdit();
  });

  useShortcutAction("vault.sourceMode", () => {
    if (!isTabActive || showGraph) return false;
    return applyMode(toggleVaultSourceMode);
  });

  // Cmd+F finds inside the open note. Declines (so the desktop app's own
  // page-find keeps working) unless a note is actually on screen in reading
  // mode — the editor has CodeMirror's own search panel.
  const [findOpen, setFindOpen] = useState(false);
  useShortcutAction("vault.find", () => {
    if (!isTabActive || showGraph || !activePath) return false;
    if (document.querySelector(".cm-content")) return false;
    setFindOpen((v) => !v);
    return true;
  });

  const activeVault = useMemo(
    () => vaults.find((v) => v.id === activeVaultId) ?? null,
    [vaults, activeVaultId],
  );

  // What the current scope MEANS — where these files live and who sees what you
  // sync out of them. A remote mirror has no local VaultInfo, only a name in the
  // remote list, so the two are folded into one shape here rather than making
  // the scope line care which it got.
  const teamForRoot = useVaultTeamResolver();
  const docTwin = useDocForFile(activeVault?.root, activePath);
  const scope = useMemo(() => {
    const remote = remoteVaults.find((v) => v.id === activeVaultId);
    const name = activeVault?.name ?? remote?.name;
    if (!name) return null;
    return {
      name,
      root: activeVault?.root,
      home: activeVault?.home,
      presence: vaultPresence({ remote: isRemote, mirror: activeVault?.mirror }),
      team: teamForRoot(activeVault?.root),
    };
  }, [activeVault, activeVaultId, remoteVaults, isRemote, teamForRoot]);

  // Land in the project's docs rather than on an empty reading pane. A repo
  // root is mostly source directories, so "pick a vault, then pick a note" puts
  // the one thing worth reading two clicks away.
  //
  // Once per vault, and never over a note the user asked for: `landedVaults`
  // remembers what we've already opened, so closing the note (which clears ?f=)
  // is respected instead of being undone on the next render.
  const landedVaults = useRef(new Set<string>());
  // Keyed on scannedAt, NOT on the file table: `files` changes on every watcher
  // event, and subscribing this always-mounted page to it would re-render the
  // whole surface on every keystroke someone makes in an editor elsewhere.
  // scannedAt moves once per scan, which is exactly when the table fills.
  const scannedAt = useVaultStore((s) => s.scannedAt);
  useWatchEffect(() => {
    // A ?path= deep link is choosing the note; the landing must not race it.
    if (!activeVault || activePath || localPath || showGraph || !scannedAt) return;
    if (landedVaults.current.has(activeVault.id)) return;
    const paths = Object.keys(useVaultStore.getState().files);
    if (!paths.length) return;
    landedVaults.current.add(activeVault.id);
    const landing = vaultLandingPath(activeVault, paths);
    if (!landing) return;
    if (activeVault.home) setDirsExpanded([activeVault.home], true);
    openNote(landing);
  }, [activeVault, activePath, showGraph, scannedAt, setDirsExpanded, openNote]);

  if (connection === "no-daemon")
    return (
      <NoDaemonTeaching
        reason={unreachableReason}
        detail={unreachableDetail}
        remoteVaults={remoteVaults}
        onRetry={() => void connect(convex, { force: true })}
        onOpenRemote={(id) => void openRemoteVault(id)}
      />
    );
  if ((connection === "connected" || connection === "cached") && vaults.length === 0 && !activeVaultId)
    return <EmptyVaultTeaching />;
  if (connection === "idle" || connection === "discovering") {
    return (
      <div className="h-full flex items-center justify-center text-sm text-sol-text-dim">
        Connecting to your files…
      </div>
    );
  }

  // The explorer column, rendered either as a split panel (wide pane) or an
  // overlay drawer (narrow pane).
  const treePane = (
          <div className="h-full flex flex-col border-r-0 bg-sol-bg-alt/40">
            <div ref={titlebarRef} className="flex items-center gap-2 px-3 py-2 border-b border-sol-border/30">
              <VaultPicker
                vaults={vaults}
                remoteVaults={remoteVaults}
                activeVaultId={activeVaultId}
                onSelect={(id, kind) => {
                  // A remote id belongs to another machine's mirror; the two
                  // open through different paths but land in the same views.
                  if (kind === "remote") void openRemoteVault(id);
                  else void selectVault(id);
                }}
              />
              {/* Tree actions, shown only while the tree is: they'd be inert
                  next to search results. */}
              {leftTab === "files" && (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    title="New note"
                    onClick={() => void createInRoot("note")}
                    className={headerButtonClass}
                  >
                    <FilePlus2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="New folder"
                    onClick={() => void createInRoot("folder")}
                    className={headerButtonClass}
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" title="Sort order" className={headerButtonClass}>
                        <ArrowUpDown className="w-3.5 h-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[170px]">
                      <DropdownMenuRadioGroup
                        value={sortMode}
                        onValueChange={(v) => setSortMode(v as VaultSortMode)}
                      >
                        {VAULT_SORT_OPTIONS.map((o) => (
                          <DropdownMenuRadioItem key={o.id} value={o.id}>
                            {o.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button type="button" title="Collapse all" onClick={collapseAll} className={headerButtonClass}>
                    <CopyMinus className="w-3.5 h-3.5" />
                  </button>
                  {/* A repo that hides its own source is lying about the folder,
                      and a notes folder full of dotfiles is noise. The default
                      follows the vault's kind; this is the override. */}
                  {!isRemote && (
                    <button
                      type="button"
                      title={showAllFiles ? "Showing all files — click for notes only" : "Show all files"}
                      aria-pressed={showAllFiles}
                      onClick={() => setShowAllFiles(!showAllFiles)}
                      className={`transition-colors ${
                        showAllFiles ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
                      }`}
                    >
                      <FileCode2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                title="Rescan"
                onClick={() => void refresh()}
                className={headerButtonClass}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title={showGraph ? "Back to notes" : "Graph view"}
                aria-pressed={showGraph}
                onClick={toggleGraph}
                className={`transition-colors ${
                  showGraph ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
                }`}
              >
                <Waypoints className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title="Hide file tree"
                onClick={() => setTreeOpen(false)}
                className={headerButtonClass}
              >
                <PanelLeftClose className="w-3.5 h-3.5" />
              </button>
            </div>
            {scope && <VaultScopeLine {...scope} docTwin={docTwin} />}
            <div className="flex items-center border-b border-sol-border/30">
              {LEFT_TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setLeftTab(id)}
                  title={label}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors border-b-2 -mb-px ${
                    leftTab === id
                      ? "border-sol-cyan text-sol-text"
                      : "border-transparent text-sol-text-dim hover:text-sol-text-muted"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <div className={`flex-1 min-h-0 ${leftTab === "files" ? "px-1 py-1" : ""}`}>
              {leftTab === "files" ? (
                <VaultExplorer activePath={activePath} onOpen={openNote} />
              ) : (
                <VaultSearchPane
                  activePath={activePath}
                  onNavigate={openNote}
                  inputRef={searchInputRef}
                />
              )}
            </div>
          </div>
  );

  return (
    <div ref={rootRef} className="h-full flex flex-col">
      {isRemote && (
        <div className="flex items-center gap-2 px-3 py-1 text-[11px] bg-sol-bg-alt text-sol-text-muted border-b border-sol-border/30">
          <Cloud className="w-3 h-3" />
          Read-only mirror from another machine — edits happen where the files live.
        </div>
      )}
      {connection === "cached" && (
        <div className="flex items-center gap-2 px-3 py-1 text-[11px] bg-sol-bg-alt text-sol-text-muted border-b border-sol-border/30">
          <WifiOff className="w-3 h-3" />
          Showing cached copy — reconnecting to the local daemon…
        </div>
      )}
      {opError && (
        <div className="flex items-center gap-2 px-3 py-1 text-[11px] bg-sol-red/10 text-sol-red border-b border-sol-red/30">
          <span className="flex-1 truncate" title={opError}>
            {opError}
          </span>
          <button type="button" onClick={clearOpError} title="Dismiss" className="hover:opacity-70">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      {renameReport && renameReport.linksRewritten + renameReport.skipped > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 text-[11px] bg-sol-bg-alt text-sol-text-muted border-b border-sol-border/30">
          <span className="flex-1 truncate">
            {renameReport.linksRewritten > 0 && (
              <>
                Updated {renameReport.linksRewritten}{" "}
                {renameReport.linksRewritten === 1 ? "link" : "links"} in {renameReport.filesChanged}{" "}
                {renameReport.filesChanged === 1 ? "note" : "notes"}
              </>
            )}
            {renameReport.skipped > 0 && (
              <span className="text-sol-yellow">
                {renameReport.linksRewritten > 0 ? " · " : ""}
                {renameReport.skipped} {renameReport.skipped === 1 ? "link" : "links"} left alone —
                those notes changed under the rename
              </span>
            )}
          </span>
          <button type="button" onClick={clearRenameReport} title="Dismiss" className="hover:opacity-70">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      <Group
        orientation="horizontal"
        className="flex-1 min-h-0"
        defaultLayout={{ "vault-tree": 20, "vault-content": rightPanelOpen ? 58 : 80, "vault-side": rightPanelOpen ? 22 : 0 }}
      >
        {paneNarrow === false && (
          <>
        <Panel
          id="vault-tree"
          panelRef={treePanelRef}
          minSize={180}
          maxSize="42%"
          collapsible
          collapsedSize={0}
          className="min-w-0"
          onResize={(size) => {
            // A drag all the way shut is a close; keep the state honest so
            // the corner button reopens it instead of doing nothing.
            if (size.asPercentage === 0 && treeAppliedRef.current && !treeExpandingRef.current) {
              treeAppliedRef.current = false;
              setTreeOpen(false);
            }
          }}
        >
          {treePane}
        </Panel>
        <Separator className={`${separatorClass} ${treeOpen ? "" : "invisible"}`} />
          </>
        )}
        {/* The graph owns everything right of the explorer: the backlinks pane
            is a list of the same edges it already draws. */}
        <Panel id="vault-content" minSize={320} className="min-w-0 relative">
          {paneNarrow === true && treeOpen && (
            <>
              <div className="absolute inset-0 z-20 bg-black/20" onClick={() => setTreeOpen(false)} />
              <div className="absolute inset-y-0 left-0 z-30 w-72 max-w-[85%] bg-sol-bg border-r border-sol-border shadow-xl">
                {treePane}
              </div>
            </>
          )}
          {!treeOpen && !findOpen && (
            <button
              type="button"
              onClick={() => setTreeOpen(true)}
              title="Show file tree"
              className="absolute top-2 left-2 z-10 p-1 rounded transition-colors hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          )}
          {!showGraph && !findOpen && (
            <button
              type="button"
              onClick={() => setRightPanelOpen(!rightPanelOpen)}
              title={rightPanelOpen ? "Hide side panel" : "Show backlinks, outline and tags"}
              aria-pressed={rightPanelOpen}
              className={`absolute top-2 right-2 z-10 p-1 rounded transition-colors hover:bg-sol-bg-alt ${
                rightPanelOpen ? "text-sol-text" : "text-sol-text-dim hover:text-sol-text"
              }`}
            >
              <PanelRight className="w-4 h-4" />
            </button>
          )}
          {showGraph ? (
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center text-sm text-sol-text-dim">
                  Loading graph…
                </div>
              }
            >
              <VaultGraphView
                activePath={activePath}
                onNavigate={(p) => openNote(p)}
                onClose={toggleGraph}
              />
            </Suspense>
          ) : activePath ? (
            <HoverPreviewProvider onNavigate={(p) => openNote(p)}>
              {findOpen && <VaultFindBar onClose={() => setFindOpen(false)} />}
              {/* Markdown gets the full reading/live/source experience; every
                  other file opens read-only. */}
              {isVaultMarkdownPath(activePath) ? (
                <VaultNoteView
                  path={activePath}
                  targetLine={targetLine}
                  mode={mode}
                  onToggleEdit={toggleEdit}
                  onNavigate={openNote}
                />
              ) : (
                <VaultFileView path={activePath} />
              )}
            </HoverPreviewProvider>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-sol-text-dim">
              <FolderTree className="w-8 h-8 opacity-30" />
              <div className="text-sm">Select a file to read it.</div>
            </div>
          )}
        </Panel>
        {!showGraph && (
          <>
            <Separator className={`${separatorClass} ${rightPanelOpen ? "" : "invisible"}`} />
            <Panel
              id="vault-side"
              panelRef={sidePanelRef}
              minSize={SIDE_MIN_PX}
              maxSize="34%"
              defaultSize={rightPanelOpen ? 22 : 0}
              collapsible
              collapsedSize={0}
              className="min-w-0"
              onResize={(size) => {
                // A drag all the way shut is a close; keep the store honest so
                // the toggle button reopens it instead of doing nothing.
                if (size.asPercentage === 0 && useVaultStore.getState().rightPanelOpen) {
                  sideAppliedRef.current = false;
                  setRightPanelOpen(false);
                }
              }}
            >
              <VaultRightPanel activePath={activePath} onNavigate={(p) => openNote(p)} />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}

export default function VaultPage() {
  return (
    <AuthGuard>
      <div className="h-full min-h-0">
        <VaultContent />
      </div>
    </AuthGuard>
  );
}
