"use client";

/**
 * Web UI for the OWNERS axis of a session (whose inboxes it appears in). The
 * platform-free logic lives in hooks/useOwners (shared with mobile); this file
 * adds the web bindings: the inbox-store roster + sonner toasts
 * (useOwnersFromStore) and the dropdown section AssignmentBadge composes
 * (OwnerMenuItems). Toggles apply optimistically and reconcile against the
 * reactive listOwners query, so the chip never flickers back mid-round-trip.
 */

import { toast } from "sonner";
import { X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwners, type OwnersApi } from "../hooks/useOwners";
import {
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "./ui/dropdown-menu";

export type { OwnersApi };

export function OwnerAvatar({ name, image, size = "w-4 h-4" }: { name: string; image?: string; size?: string }) {
  if (image) return <img src={image} alt={name} className={`${size} rounded-full object-cover`} />;
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className={`${size} rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted`}>
      {initials || "?"}
    </div>
  );
}

/** The shared owners logic bound to the web environment: store roster + sonner. */
export function useOwnersFromStore(conversationId: string): OwnersApi {
  const teamMembers = useInboxStore((s) => s.teamMembers) as any[];
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  return useOwners(conversationId, {
    teamMembers,
    currentUser,
    notify: (msg, kind) => (kind === "success" ? toast.success(msg) : toast.error(msg)),
  });
}

/**
 * The owners section of an assignment popover: label + team roster as
 * checkboxes + clear-all. Drop inside an open DropdownMenuContent; rows
 * preventDefault so the menu stays open across multi-select toggles.
 */
export function OwnerMenuItems({ owners }: { owners: OwnersApi }) {
  const { ownerIds, ownerList, displayFor, toggle, clearAll, selectable, currentUser } = owners;
  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">
        Owners · whose inbox
      </DropdownMenuLabel>
      {selectable.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-sol-text-dim">No teammates</div>
      )}
      {selectable.map((m: any) => {
        const isYou = currentUser && m._id === currentUser._id;
        return (
          <DropdownMenuCheckboxItem
            key={m._id}
            checked={ownerIds.has(m._id)}
            onSelect={(e) => { e.preventDefault(); toggle(m._id); }}
            className="text-xs gap-2"
          >
            <OwnerAvatar name={m.name || m.email || "?"} image={m.image || m.github_avatar_url} />
            <span className="flex-1 truncate">
              {m.name || m.email?.split("@")[0]}
              {isYou ? " (you)" : ""}
            </span>
          </DropdownMenuCheckboxItem>
        );
      })}
      {ownerList.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); clearAll(); }}
            className="text-[11px] text-sol-text-dim focus:text-sol-red gap-1.5"
          >
            <X className="w-3 h-3" /> Clear all owners
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
