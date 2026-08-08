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
import { getProjectName, useInboxStore, selectSessionRailOpen } from "../../store/inboxStore";
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

// Only the surprising cases earn words on the line. "On this machine" is what
// the laptop icon already says and what every row would repeat; synced and
// elsewhere are the ones a person needs told. The full sentence is the tooltip.
const PRESENCE_PHRASE: Partial<Record<VaultPresence, string>> = {
  both: "synced",
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
  const fullRoot = root && home ? `${root}/${home}` : root;

  // The same gesture the command palette and the project chips use: the inbox
  // IS the project's page — a filter over its sessions — so set the filter and
  // go there rather than inventing a second surface.
  const openProject = useCallback(() => {
    if (!root) return;
    const store = useInboxStore.getState();
    store.setActiveProjectFilter(getProjectName(root), root);
    if (!selectSessionRailOpen(store)) store.toggleSidePanel();
    router.push("/inbox");
  }, [router, root]);

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-sol-text-dim border-b border-sol-border/30"
      title={describeVaultScope({ root, presence, team })}
    >
      <PresenceIcon className="w-3 h-3 flex-shrink-0" />
      {/* Scope first, location second. This rail collapses to 180px, where only
          one of the two survives — and who can see your writing is the part a
          person cannot recover from the tree, the picker, or a hover.

          The lopsided shrink factors below make that a strict order rather than
          a proportional squeeze: the path absorbs essentially all of it and
          reaches zero before the clause gives up a character, and the clause
          then ellipses rather than shoving the buttons off the rail. */}
      <span className="flex items-center gap-1 min-w-0">
        {PRESENCE_PHRASE[presence] && (
          <span className="flex-shrink-0">{PRESENCE_PHRASE[presence]} ·</span>
        )}
        {/* truncate belongs on the text itself — on a flex CONTAINER it clips
            mid-word with no ellipsis, and "shared with Code" reads like a
            different team rather than a shortened one. */}
        <span
          className={`truncate min-w-0 ${
            team.kind === "team" && team.shared ? "text-sol-green" : ""
          }`}
        >
          {teamScopeWords(team)}
        </span>
      </span>
      {/* The directory, not the display name: two checkouts of one repo share a
          name and nothing else. `home` joins the path rather than sitting beside
          it as its own chip — the directory you are actually reading is one
          fact, and writing it as one costs no width the path was not already
          spending. */}
      {/* min-w-0: without it a flex item refuses to shrink below its text, and
          the overflow pushes the buttons off the rail instead of ellipsing. */}
      <span className="truncate min-w-0 [flex-shrink:9999]" title={fullRoot ?? name}>
        · {fullRoot ? shortenVaultRoot(fullRoot) : name}
      </span>
      {/* Icon-only, like the project link beside it: spelling out "Also a doc"
          cost more of this rail than the path itself, and the tooltip is where
          the useful part — WHICH doc — lives anyway. */}
      {docTwin && (
        <button
          type="button"
          onClick={() => router.push(`/docs/${docTwin._id}`)}
          title={`Also a doc in codecast: ${docTwin.title}`}
          className="ml-auto flex-shrink-0 text-sol-cyan hover:opacity-80 transition-opacity"
        >
          <FileText className="w-3 h-3" />
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
