"use client";
// One line under the picker that says, in words, what the current scope means:
// which directory you are reading, where those files live, and who can see what
// you sync out of them.
//
// It exists because guessing is what made this surface feel incoherent. Docs are
// scoped by team and files are scoped by directory, and with nothing on screen
// tying the two together, "where did I write that?" had no reliable answer. The
// directory already knows its team — this is where it says so.
//
// Every scope gets the line, not just projects: a plain notes folder being
// personal is as much worth stating as a repo being shared.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Cloud, FileText, Laptop } from "lucide-react";
import { getProjectName, useInboxStore } from "../../store/inboxStore";
import { shortenVaultRoot } from "../../lib/vault/projectVault";
import {
  describeVaultScope,
  teamScopeWords,
  type VaultPresence,
  type VaultTeamScope,
} from "../../lib/vault/scopeModel";

const PRESENCE_ICON: Record<VaultPresence, React.ComponentType<{ className?: string }>> = {
  "this-machine": Laptop,
  both: Cloud,
  "other-machine": Cloud,
};

const PRESENCE_PHRASE: Record<VaultPresence, string> = {
  "this-machine": "on this machine",
  both: "on this machine, synced",
  "other-machine": "on another machine",
};

export function VaultScopeLine({
  name,
  root,
  home,
  presence,
  team,
  docTwin,
}: {
  name: string;
  /** Absent for a remote mirror: a projection of another machine's directory is
   *  not a path this one can name, let alone open. */
  root?: string;
  /** Vault-relative directory the scope opens in ("docs" for a repo that has one). */
  home?: string;
  presence: VaultPresence;
  team: VaultTeamScope;
  /** The codecast doc mirroring the open file, when there is one. The other half
   *  of the answer to "where did I write that?" */
  docTwin?: { _id: string; title: string } | null;
}) {
  const router = useRouter();
  const PresenceIcon = PRESENCE_ICON[presence];

  // The same gesture the command palette and the project chips use: the inbox
  // IS the project's page — a filter over its sessions — so set the filter and
  // go there rather than inventing a second surface.
  const openProject = useCallback(() => {
    if (!root) return;
    const store = useInboxStore.getState();
    store.setActiveProjectFilter(getProjectName(root), root);
    if (!store.sidePanelOpen) store.toggleSidePanel();
    router.push("/inbox");
  }, [router, root]);

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-sol-text-dim border-b border-sol-border/30"
      title={describeVaultScope({ root, presence, team })}
    >
      <PresenceIcon className="w-3 h-3 flex-shrink-0" />
      {/* The directory, not the display name: two checkouts of one repo share a
          name and nothing else. */}
      <span className="truncate" title={root}>
        {root ? shortenVaultRoot(root) : name}
      </span>
      {home && (
        <span className="flex-shrink-0 text-sol-cyan" title={`Opens in ${home}/`}>
          {home}
        </span>
      )}
      <span className="flex-shrink-0">·</span>
      <span className="truncate">
        {PRESENCE_PHRASE[presence]},{" "}
        <span className={team.kind === "team" && team.shared ? "text-sol-green" : undefined}>
          {teamScopeWords(team)}
        </span>
      </span>
      {docTwin && (
        <button
          type="button"
          onClick={() => router.push(`/docs/${docTwin._id}`)}
          title={`This file is also a doc in codecast: ${docTwin.title}`}
          className="ml-auto flex items-center gap-1 flex-shrink-0 text-sol-cyan hover:opacity-80 transition-opacity"
        >
          <FileText className="w-3 h-3" />
          Also a doc
        </button>
      )}
      {root && (
        <button
          type="button"
          onClick={openProject}
          title={`Show ${name} sessions in codecast`}
          className={`${docTwin ? "" : "ml-auto"} flex-shrink-0 hover:text-sol-cyan transition-colors`}
        >
          <ArrowUpRight className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
