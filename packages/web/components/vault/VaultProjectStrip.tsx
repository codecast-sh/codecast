"use client";
// One line under the vault picker, shown only for a project vault: which
// directory on disk you are reading, and a way back to that project inside
// codecast. A project vault is the one kind whose name alone is ambiguous —
// two checkouts of the same repo have the same name — so the path earns its
// row, and having arrived from a repo you usually want its sessions next.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, FolderGit2 } from "lucide-react";
import type { VaultInfo } from "@codecast/shared/contracts";
import { getProjectName, useInboxStore } from "../../store/inboxStore";
import { shortenVaultRoot } from "../../lib/vault/projectVault";

export function VaultProjectStrip({ vault }: { vault: VaultInfo }) {
  const router = useRouter();

  // The same gesture the command palette and the project chips use: the inbox
  // IS the project's page — a filter over its sessions — so set the filter and
  // go there rather than inventing a second surface.
  const openProject = useCallback(() => {
    const store = useInboxStore.getState();
    store.setActiveProjectFilter(getProjectName(vault.root), vault.root);
    if (!store.sidePanelOpen) store.toggleSidePanel();
    router.push("/inbox");
  }, [router, vault.root]);

  return (
    <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-sol-text-dim border-b border-sol-border/30">
      <FolderGit2 className="w-3 h-3 flex-shrink-0" />
      <span className="truncate" title={vault.root}>
        {shortenVaultRoot(vault.root)}
      </span>
      {vault.home && (
        <span className="flex-shrink-0 text-sol-cyan" title={`Opens in ${vault.home}/`}>
          {vault.home}
        </span>
      )}
      <button
        type="button"
        onClick={openProject}
        title={`Show ${vault.name} sessions in codecast`}
        className="ml-auto flex-shrink-0 hover:text-sol-cyan transition-colors"
      >
        <ArrowUpRight className="w-3 h-3" />
      </button>
    </div>
  );
}
