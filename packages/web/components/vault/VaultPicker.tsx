"use client";
// The vault picker. Replaces a bare <select> because the list is no longer one
// flat set of folders somebody registered: it is the user's projects, which
// codecast already knew about, alongside any vault they added by hand and
// anything mirrored from another machine. Those read differently and have to
// LOOK different, or a project full of source directories is indistinguishable
// from a notes folder until you open it.

import { useMemo, useState } from "react";
import { Check, ChevronDown, Cloud, FolderGit2, FolderTree, Laptop, Users } from "lucide-react";
import type { VaultInfo } from "@codecast/shared/contracts";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  groupVaultChoices,
  shortenVaultRoot,
  type VaultSourceKind,
} from "../../lib/vault/projectVault";
import {
  PRESENCE_LABELS,
  describeVaultScope,
  teamScopeLabel,
  vaultPresence,
  type VaultPresence,
} from "../../lib/vault/scopeModel";
import { useVaultTeamResolver } from "./useVaultScope";

const KIND_ICON: Record<VaultSourceKind, React.ComponentType<{ className?: string }>> = {
  vault: FolderTree,
  project: FolderGit2,
  remote: Cloud,
};

const PRESENCE_ICON: Record<VaultPresence, React.ComponentType<{ className?: string }>> = {
  "this-machine": Laptop,
  both: Cloud,
  "other-machine": Cloud,
};

// Where the bytes are, as a chip. The plain case stays dim and the two that
// involve codecast take the accent: the point of the badge is that you can tell
// them apart without opening anything, not that every row shouts.
const PRESENCE_TONE: Record<VaultPresence, string> = {
  "this-machine": "text-sol-text-dim",
  both: "text-sol-cyan",
  "other-machine": "text-sol-violet",
};

function PresenceChip({ presence, title }: { presence: VaultPresence; title: string }) {
  const Icon = PRESENCE_ICON[presence];
  return (
    <span
      className={`flex items-center gap-1 flex-shrink-0 text-[10px] ${PRESENCE_TONE[presence]}`}
      title={title}
    >
      <Icon className="w-3 h-3" />
      {PRESENCE_LABELS[presence]}
    </span>
  );
}

export function VaultPicker({
  vaults,
  remoteVaults,
  activeVaultId,
  onSelect,
}: {
  vaults: VaultInfo[];
  remoteVaults: { id: string; name: string; note_count?: number }[];
  activeVaultId: string | null;
  /** The two open through different paths — local disk versus a Convex
   *  projection — so the caller is told which it picked. */
  onSelect: (id: string, kind: VaultSourceKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupVaultChoices(vaults, remoteVaults), [vaults, remoteVaults]);
  const active =
    groups.flatMap((g) => g.items).find((c) => c.id === activeVaultId) ?? null;
  const ActiveIcon = KIND_ICON[active?.kind ?? "vault"];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const teamForRoot = useVaultTeamResolver();

  // Both questions a row has to answer, together: where the files are, and who
  // sees what you sync out of them.
  const scopeOf = (choice: { kind: VaultSourceKind; root?: string; mirror?: boolean }) => {
    const presence = vaultPresence({ remote: choice.kind === "remote", mirror: choice.mirror });
    const team = teamForRoot(choice.root);
    return { presence, team, sentence: describeVaultScope({ root: choice.root, presence, team }) };
  };

  const activeSentence = active ? scopeOf(active).sentence : undefined;

  if (total <= 1) {
    return (
      <div
        className="flex-1 flex items-center gap-1.5 min-w-0 text-xs font-medium text-sol-text"
        title={activeSentence}
      >
        <ActiveIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
        <span className="truncate">{active?.name ?? "Vault"}</span>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={activeSentence ?? "Choose a project or folder"}
          className="flex-1 flex items-center gap-1.5 min-w-0 text-xs font-medium text-sol-text hover:text-sol-cyan transition-colors"
        >
          <ActiveIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
          <span className="truncate">{active?.name ?? "Choose a vault"}</span>
          <ChevronDown className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[340px]">
        {/* Filtering, not scrolling: this list is every project on the machine,
            which is hundreds of rows on a working developer's laptop. */}
        <Command
          filter={(value, search) =>
            value.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Find a vault or project" />
          <CommandList className="max-h-[50vh]">
            <CommandEmpty className="py-6 text-center text-xs text-sol-text-dim">
              No vault or project matches.
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.kind} heading={group.label}>
                {group.items.map((choice) => {
                  const Icon = KIND_ICON[choice.kind];
                  const selected = choice.id === activeVaultId;
                  const scope = scopeOf(choice);
                  return (
                    <CommandItem
                      key={choice.id}
                      // Path and team are searchable too: a renamed vault should
                      // still be findable by the directory it points at, and
                      // "which of these belong to Acme" is a real question.
                      value={`${choice.name} ${choice.root ?? ""} ${teamScopeLabel(scope.team)}`}
                      onSelect={() => {
                        setOpen(false);
                        if (!selected) onSelect(choice.id, choice.kind);
                      }}
                      className="gap-2 items-start"
                    >
                      <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-text-dim" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-[13px] text-sol-text">{choice.name}</span>
                        {/* One meta line: where on disk, how much, and who can
                            see what you sync from it. */}
                        <span className="flex items-center gap-1 min-w-0 text-[10px] text-sol-text-dim">
                          <span className="truncate">
                            {[
                              choice.root && shortenVaultRoot(choice.root),
                              choice.noteCount !== undefined &&
                                `${choice.noteCount} ${choice.noteCount === 1 ? "note" : "notes"}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <span
                            className={`flex items-center gap-0.5 flex-shrink-0 ${
                              scope.team.kind === "team" && scope.team.shared ? "text-sol-green" : ""
                            }`}
                          >
                            {scope.team.kind === "team" && <Users className="w-2.5 h-2.5" />}
                            {teamScopeLabel(scope.team)}
                          </span>
                        </span>
                      </span>
                      <PresenceChip presence={scope.presence} title={scope.sentence} />
                      {selected && <Check className="w-3 h-3 flex-shrink-0 mt-0.5 text-sol-cyan" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
