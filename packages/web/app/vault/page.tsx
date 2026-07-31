"use client";
// /vault — Obsidian-style browsing of a connected local directory of markdown
// files. The daemon's loopback bridge serves the files; selection is URL-driven
// (?f=<vault-relative path>) so history, tabs, and deep links all work.

import { useCallback, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvex } from "convex/react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { FolderTree, RefreshCw, WifiOff } from "lucide-react";
import { AuthGuard } from "../../components/AuthGuard";
import { useTabContext } from "../../components/TabContent";
import { VaultExplorer } from "../../components/vault/VaultExplorer";
import { VaultNoteView } from "../../components/vault/VaultNoteView";
import { useVaultStore } from "../../store/vaultStore";

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

function VaultContent() {
  const convex = useConvex();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabCtx = useTabContext();
  const isTabActive = (tabCtx as { isActive?: boolean } | null)?.isActive !== false;

  const connection = useVaultStore((s) => s.connection);
  const vaults = useVaultStore((s) => s.vaults);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const connect = useVaultStore((s) => s.connect);
  const selectVault = useVaultStore((s) => s.selectVault);
  const refresh = useVaultStore((s) => s.refresh);
  const noteOpened = useVaultStore((s) => s.noteOpened);

  const activePath = searchParams.get("f");

  useEffect(() => {
    if (connection === "idle") void connect(convex);
  }, [connection, connect, convex]);

  const openNote = useCallback(
    (path: string | null) => {
      if (path) {
        noteOpened(path);
        router.push(`/vault?f=${encodeURIComponent(path)}`);
      } else {
        router.push("/vault");
      }
    },
    [router, noteOpened],
  );

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
      <Group
        orientation="horizontal"
        className="flex-1 min-h-0"
        defaultLayout={{ "vault-tree": 22, "vault-content": 78 }}
      >
        <Panel id="vault-tree" minSize={12} maxSize={40} defaultSize={22} className="min-w-0">
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
              <button
                type="button"
                title="Rescan vault"
                onClick={() => void refresh()}
                className="text-sol-text-dim hover:text-sol-text transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 px-1 py-1">
              <VaultExplorer activePath={activePath} onOpen={(p) => openNote(p)} />
            </div>
          </div>
        </Panel>
        <Separator className={separatorClass} />
        <Panel id="vault-content" minSize={40} className="min-w-0">
          {activePath ? (
            <VaultNoteView path={activePath} onNavigate={openNote} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-sol-text-dim">
              <FolderTree className="w-8 h-8 opacity-30" />
              <div className="text-sm">Select a note to read it.</div>
            </div>
          )}
        </Panel>
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
