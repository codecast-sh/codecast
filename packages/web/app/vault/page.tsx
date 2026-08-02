"use client";
// /vault — Obsidian-style browsing of a connected local directory of markdown
// files. The daemon's loopback bridge serves the files; selection is URL-driven
// (?f=<vault-relative path>) so history, tabs, and deep links all work.

import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvex } from "convex/react";
import { Panel, Group, Separator } from "react-resizable-panels";
import {
  ArrowUpDown,
  Cloud,
  CopyMinus,
  FilePlus2,
  FolderPlus,
  FolderTree,
  RefreshCw,
  Search,
  Waypoints,
  WifiOff,
  X,
} from "lucide-react";
import { AuthGuard } from "../../components/AuthGuard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { VAULT_SORT_OPTIONS, type VaultSortMode } from "../../lib/vault/explorerModel";
import { useTabContext } from "../../components/TabContent";
import { useShortcutAction } from "../../shortcuts";
import { VaultExplorer } from "../../components/vault/VaultExplorer";
import { VaultNoteView } from "../../components/vault/VaultNoteView";
import { VaultRightPanel } from "../../components/vault/VaultRightPanel";
import { VaultFindBar } from "../../components/vault/VaultFindBar";
import { HoverPreviewProvider } from "../../components/vault/VaultHoverPreview";
import { VaultSearchPane } from "../../components/vault/VaultSearchPane";
import { useVaultStore } from "../../store/vaultStore";
import {
  toggleVaultEditMode,
  toggleVaultSourceMode,
  vaultViewMode,
  setVaultModeScope,
  type VaultViewMode,
} from "../../lib/vault/viewMode";

// sigma + graphology are ~40kB gzip: nobody who doesn't open the graph pays.
const VaultGraphView = lazy(() =>
  import("../../components/vault/VaultGraphView").then((m) => ({ default: m.VaultGraphView })),
);

const headerButtonClass = "text-sol-text-dim hover:text-sol-text transition-colors";

const separatorClass =
  "relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

function EmptyVaultTeaching() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
      <FolderTree className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">Connect a vault</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        A vault is a folder of markdown files on your machine. Register one with
        the CLI and it appears here instantly:
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
  remoteVaults,
  onRetry,
  onOpenRemote,
}: {
  reason: "none" | "no-devices" | "probe-failed" | "old-daemon";
  remoteVaults: { id: string; name: string; note_count?: number }[];
  onRetry: () => void;
  onOpenRemote: (id: string) => void;
}) {
  // One dead end used to answer three different problems. The browser blocking
  // a loopback request looks nothing like a daemon that isn't running, and
  // telling someone to restart a healthy daemon wastes their time.
  const copy = {
    "probe-failed": {
      title: "Your browser is blocking this machine",
      body: (
        <>
          The daemon is running and answered, but the browser wouldn&apos;t let this page
          reach it. Chrome asks permission the first time a site connects to your local
          network — allow it from the address-bar icon, then retry. The desktop app has no
          such gate.
        </>
      ),
    },
    "no-devices": {
      title: "Can't reach the local daemon",
      body: (
        <>
          The vault reads files straight from this machine, which needs the codecast daemon
          running. Start it with <code className="text-sol-text">cast daemon</code> or check{" "}
          <code className="text-sol-text">cast doctor</code>. If it IS running, make sure
          you&apos;re signed in as the same account it belongs to.
        </>
      ),
    },
    "old-daemon": {
      title: "This machine's daemon is too old for vaults",
      body: (
        <>
          It answered, but it doesn&apos;t serve the vault routes yet. Run{" "}
          <code className="text-sol-text">cast update</code> and try again.
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

  const activePath = searchParams.get("f");
  const targetLineRaw = searchParams.get("l");
  const targetLine = targetLineRaw ? parseInt(targetLineRaw, 10) : undefined;
  const showGraph = searchParams.get("view") === "graph";
  const leftTab = useVaultStore((s) => s.leftPaneTab);
  const setLeftTab = useVaultStore((s) => s.setLeftPaneTab);

  useWatchEffect(() => {
    if (connection === "idle") void connect(convex);
  }, [connection, connect, convex]);

  // `line` rides along in the URL for search results: the note view doesn't
  // scroll to it yet, but the link already carries where the hit was.
  const openNote = useCallback(
    (path: string | null, line?: number) => {
      if (path) {
        noteOpened(path);
        const at = line ? `&l=${line}` : "";
        router.push(`/vault?f=${encodeURIComponent(path)}${at}`);
      } else {
        router.push("/vault");
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
    const params = new URLSearchParams();
    if (activePath) params.set("f", activePath);
    if (!showGraph) params.set("view", "graph");
    const query = params.toString();
    router.push(query ? `/vault?${query}` : "/vault");
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

  if (connection === "no-daemon")
    return (
      <NoDaemonTeaching
        reason={unreachableReason}
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
        Connecting to vault…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
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
        defaultLayout={{ "vault-tree": 20, "vault-content": 58, "vault-side": 22 }}
      >
        <Panel id="vault-tree" minSize={180} maxSize="42%" className="min-w-0">
          <div className="h-full flex flex-col border-r-0 bg-sol-bg-alt/40">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-border/30">
              {vaults.length + remoteVaults.length > 1 ? (
                <select
                  value={activeVaultId ?? ""}
                  onChange={(e) => {
                    const id = e.target.value;
                    // A remote id belongs to another machine's mirror; the two
                    // open through different paths but land in the same views.
                    if (remoteVaults.some((v) => v.id === id)) void openRemoteVault(id);
                    else void selectVault(id);
                  }}
                  className="flex-1 bg-transparent text-xs font-medium text-sol-text outline-none cursor-pointer"
                >
                  {vaults.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                  {remoteVaults
                    .filter((rv) => !vaults.some((v) => v.id === rv.id))
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} (remote)
                      </option>
                    ))}
                </select>
              ) : (
                <div className="flex-1 text-xs font-medium text-sol-text truncate" title={activeVault?.root}>
                  {activeVault?.name ?? "Vault"}
                </div>
              )}
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
                </div>
              )}
              <button
                type="button"
                title="Rescan vault"
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
            </div>
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
        </Panel>
        <Separator className={separatorClass} />
        {/* The graph owns everything right of the explorer: the backlinks pane
            is a list of the same edges it already draws. */}
        <Panel id="vault-content" minSize={400} className="min-w-0 relative">
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
              <VaultNoteView
                path={activePath}
                targetLine={targetLine}
                mode={mode}
                onToggleEdit={toggleEdit}
                onNavigate={openNote}
              />
            </HoverPreviewProvider>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-sol-text-dim">
              <FolderTree className="w-8 h-8 opacity-30" />
              <div className="text-sm">Select a note to read it.</div>
            </div>
          )}
        </Panel>
        {!showGraph && (
          <>
            <Separator className={separatorClass} />
            <Panel
              id="vault-side"
              minSize={200}
              maxSize="34%"
              collapsible
              collapsedSize={0}
              className="min-w-0"
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
