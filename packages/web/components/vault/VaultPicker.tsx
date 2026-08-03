"use client";
// The vault picker. Replaces a bare <select> because the list is no longer one
// flat set of folders somebody registered: it is the user's projects, which
// codecast already knew about, alongside any vault they added by hand and
// anything mirrored from another machine. Those read differently and have to
// LOOK different, or a project full of source directories is indistinguishable
// from a notes folder until you open it.

import { useMemo, useState } from "react";
import { Check, ChevronDown, Cloud, FolderGit2, FolderTree } from "lucide-react";
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

const KIND_ICON: Record<VaultSourceKind, React.ComponentType<{ className?: string }>> = {
  vault: FolderTree,
  project: FolderGit2,
  remote: Cloud,
};

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

  if (total <= 1) {
    return (
      <div
        className="flex-1 flex items-center gap-1.5 min-w-0 text-xs font-medium text-sol-text"
        title={active?.root}
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
          title={active?.root ?? "Choose a vault"}
          className="flex-1 flex items-center gap-1.5 min-w-0 text-xs font-medium text-sol-text hover:text-sol-cyan transition-colors"
        >
          <ActiveIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
          <span className="truncate">{active?.name ?? "Choose a vault"}</span>
          <ChevronDown className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[300px]">
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
                  return (
                    <CommandItem
                      key={choice.id}
                      // The path is searchable too: a renamed vault should still
                      // be findable by the directory it actually points at.
                      value={`${choice.name} ${choice.root ?? ""}`}
                      onSelect={() => {
                        setOpen(false);
                        if (!selected) onSelect(choice.id, choice.kind);
                      }}
                      className="gap-2"
                    >
                      <Icon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-[13px] text-sol-text">{choice.name}</span>
                        {choice.root && (
                          <span className="block truncate text-[10px] text-sol-text-dim">
                            {shortenVaultRoot(choice.root)}
                          </span>
                        )}
                      </span>
                      {choice.noteCount !== undefined && (
                        <span className="text-[10px] text-sol-text-dim flex-shrink-0">
                          {choice.noteCount}
                        </span>
                      )}
                      {selected && <Check className="w-3 h-3 flex-shrink-0 text-sol-cyan" />}
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
