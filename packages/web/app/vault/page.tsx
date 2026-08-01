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
import { HoverPreviewProvider } from "../../components/vault/VaultHoverPreview";
import { VaultSearchPane } from "../../components/vault/VaultSearchPane";
import { useVaultStore } from "../../store/vaultStore";

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

function NoDaemonTeaching() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
      <WifiOff className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">Can&apos;t reach the local daemon</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        The vault reads files straight from this machine, which needs the
        codecast daemon running. Start it with <code className="text-sol-text">cast daemon</code>{" "}
        or check <code className="text-sol-text">cast doctor</code>.
      </div>
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
  const refresh = useVaultStore((s) => s.refresh);
  const noteOpened = useVaultStore((s) => s.noteOpened);
  const sortMode = useVaultStore((s) => s.sortMode);
  const setSortMode = useVaultStore((s) => s.setSortMode);
  const newNote = useVaultStore((s) => s.newNote);
  const newFolder = useVaultStore((s) => s.newFolder);
  const setDirsExpanded = useVaultStore((s) => s.setDirsExpanded);
  const opError = useVaultStore((s) => s.opError);
  const clearOpError = useVaultStore((s) => s.clearOpError);

  const activePath = searchParams.get("f");
  const targetLineRaw = searchParams.get("l");
  const targetLine = targetLineRaw ? parseInt(targetLineRaw, 10) : undefined;
  const showGraph = searchParams.get("view") === "graph";
  const [leftTab, setLeftTab] = useState<"files" | "search">("files");

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
    [newNote, newFolder, openNote],
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

  const activeVault = useMemo(
    () => vaults.find((v) => v.id === activeVaultId) ?? null,
    [vaults, activeVaultId],
  );

  if (connection === "no-daemon") return <NoDaemonTeaching />;
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
      <Group
        orientation="horizontal"
        className="flex-1 min-h-0"
        defaultLayout={{ "vault-tree": 20, "vault-content": 58, "vault-side": 22 }}
      >
        <Panel id="vault-tree" minSize={180} maxSize="42%" className="min-w-0">
          <div className="h-full flex flex-col border-r-0 bg-sol-bg-alt/40">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-border/30">
              {vaults.length > 1 ? (
                <select
                  value={activeVaultId ?? ""}
                  onChange={(e) => void selectVault(e.target.value)}
                  className="flex-1 bg-transparent text-xs font-medium text-sol-text outline-none cursor-pointer"
                >
                  {vaults.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
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
        <Panel id="vault-content" minSize={400} className="min-w-0">
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
            <HoverPreviewProvider>
              <VaultNoteView path={activePath} targetLine={targetLine} onNavigate={openNote} />
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
