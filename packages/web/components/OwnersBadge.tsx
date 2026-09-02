"use client";

/**
 * Web UI for the OWNERS axis of a session (whose inboxes it appears in). The
 * platform-free logic lives in hooks/useOwners (shared with mobile); this file
 * adds the web bindings: the inbox-store roster + sonner toasts
 * (useOwnersFromStore) and the dropdown section AssignmentBadge composes
 * (OwnerMenuItems). Toggles apply optimistically and reconcile against the
 * reactive listOwners query, so the chip never flickers back mid-round-trip.
 */

import { useState } from "react";
import { toast } from "sonner";
import { X, UserCheck } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwners, useOwnerCandidates, pickRoster, type OwnersApi } from "../hooks/useOwners";
import { AvatarImg } from "../lib/avatarCache";
import { formatRelative, formatDateFull } from "../lib/utils";
import {
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "./ui/dropdown-menu";

export type { OwnersApi };

export function OwnerAvatar({ name, image, size = "w-4 h-4" }: { name: string; image?: string; size?: string }) {
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <AvatarImg
      src={image}
      alt={name}
      className={`${size} rounded-full object-cover`}
      fallback={
        <div className={`${size} rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted`}>
          {initials || "?"}
        </div>
      }
    />
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
export function OwnerMenuItems({
  owners,
  conversationId,
}: {
  owners: OwnersApi;
  conversationId: string;
}) {
  const { ownerIds, ownerList, displayFor, toggle, clearAll, currentUser } = owners;
  // Mounted only while the assignment menu is open (Radix unmounts Content
  // when closed). This is the team-roster collect that must not run for
  // every open conversation.
  const serverRoster = useOwnerCandidates(conversationId, currentUser);
  const selectable = pickRoster(serverRoster, owners.selectable).filter(
    (m: any) => m && !m.is_bot,
  );
  // Optional handoff note, sent along with the NEXT assignment made from this
  // menu. It rides the notification (push + inbox row) and the assignee's
  // "assigned to you" banner, then clears once used.
  const [note, setNote] = useState("");
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
            onSelect={(e) => {
              e.preventDefault();
              const wasOwner = ownerIds.has(m._id);
              toggle(m._id, wasOwner ? undefined : note);
              if (!wasOwner) setNote("");
            }}
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
      {selectable.some((m: any) => !currentUser || m._id !== currentUser._id) && (
        <div className="px-2 pt-1 pb-1.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            // The dropdown's typeahead would otherwise swallow letter keys.
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Add a note with the assignment…"
            className="w-full px-1.5 py-1 text-[11px] rounded border border-sol-border/50 bg-sol-bg text-sol-text placeholder:text-sol-text-dim/60 outline-none focus:border-sol-cyan/60"
          />
        </div>
      )}
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

/**
 * The can't-miss handoff strip shown at the top of an open conversation the
 * current user was assigned by someone ELSE and hasn't acknowledged. Shows the
 * assigner + their optional note; "Got it" acks (server) and clears the inbox
 * row's assigned ping (local-first), so both surfaces retire together.
 */
export function AssignedToYouBanner({ conversationId }: { conversationId: string }) {
  const owners = useOwnersFromStore(conversationId);
  const a = owners.myAssignment;
  if (!a) return null;
  const by = a.added_by_name || "A teammate";
  return (
    <div className="flex items-start gap-2.5 mx-3 my-2 px-3 py-2.5 rounded-lg border border-sol-violet/50 bg-sol-violet/10 shadow-[0_0_12px_rgba(108,113,196,0.15)]">
      <UserCheck className="w-4 h-4 text-sol-violet flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-sol-text">
          {by} assigned this thread to you
          {a.added_at && (
            <span className="font-normal text-sol-text-dim whitespace-nowrap" title={formatDateFull(a.added_at)}>
              {" · "}{formatRelative(a.added_at)}
            </span>
          )}
        </div>
        {a.note && (
          <div className="text-xs text-sol-text-muted mt-0.5 whitespace-pre-wrap break-words">
            “{a.note}”
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          owners.ack();
          useInboxStore.getState().clearAssignedPing(conversationId);
        }}
        className="flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium bg-sol-violet/20 text-sol-violet border border-sol-violet/40 hover:bg-sol-violet/30 transition-colors"
      >
        Got it
      </button>
    </div>
  );
}
