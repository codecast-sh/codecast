"use client";

/**
 * Web UI for the OWNERS axis of a session (whose inboxes it appears in). The
 * platform-free logic lives in hooks/useOwners (shared with mobile); this file
 * adds the web bindings: the inbox-store roster + sonner toasts
 * (useOwnersFromStore) and the dropdown section AssignmentBadge composes
 * (OwnerMenuItems). Toggles apply optimistically and reconcile against the
 * reactive listOwners query, so the chip never flickers back mid-round-trip.
 */

import { useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { X, UserCheck, ArrowRightLeft, Network } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwners, useOwnerCandidates, pickRoster, type OwnersApi, type HandoffInfo } from "../hooks/useOwners";
import { useOrgRoles } from "../hooks/useOrgRoles";
import { useSyncOrgTreeFeeder } from "../hooks/useSyncOrgTree";
import { reparentToastLine } from "../store/orgSlice";
import { RoleFace } from "./org/RoleFace";
import { AvatarImg } from "../lib/avatarCache";
import { formatRelative, formatDateFull } from "../lib/utils";
import {
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from "./ui/command";
import { Switch } from "./ui/switch";
import { KeyCap } from "./KeyboardShortcutsHelp";

export type { OwnersApi, HandoffInfo };

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

/** The shared owners logic bound to the web environment: store roster + sonner.
 *  On web the owner axis rides the org store's one reparent path (S11): every
 *  add, remove, take-ownership and handoff dispatches through
 *  reparentOrgSession, so the chart node moves in the same tick and one write
 *  reaches the core. The toast says both things from the told counts. */
export function useOwnersFromStore(conversationId: string): OwnersApi {
  const teamMembers = useInboxStore((s) => s.teamMembers) as any[];
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  const starterIds = useInboxStore(useShallow((s) => {
    const live = typeof (s as any).resolveLiveSessionId === "function"
      ? (s as any).resolveLiveSessionId(conversationId)
      : conversationId;
    const row = (s.sessions as any)?.[live] ?? (s.conversations as any)?.[conversationId];
    return [row?.author_user_id ?? null, row?.user_id ?? null] as const;
  }));
  const implicitOwnerId = (() => {
    const isBot = (id: string) => {
      if (currentUser?._id === id) return !!currentUser.is_bot;
      const m = teamMembers?.find((x: any) => x._id === id);
      return m ? !!m.is_bot : false;
    };
    for (const id of starterIds) {
      if (id && !isBot(id)) return id as string;
    }
    return undefined;
  })();
  return useOwners(conversationId, {
    teamMembers,
    currentUser,
    implicitOwnerId,
    notify: (msg, kind) => (kind === "success" ? toast.success(msg) : toast.error(msg)),
    reparent: async (target, opts) => {
      const r = await useInboxStore.getState().reparentOrgSession(conversationId, target, { note: opts.note });
      // Always a SESSION reparent here, whether the new parent is a person or a
      // role: the session is what is told. A stale session is DEFERRED rather
      // than woken, which still deserves the line — it says when it will read.
      if (r && (r.told?.sessions || r.told?.deferred)) {
        toast.success(reparentToastLine(r.short_id ?? "The session", r.reports_to?.name ?? opts.parentName ?? "its new parent", "session", r.told));
      } else if (opts.toastFallback) {
        toast.success(opts.toastFallback);
      }
    },
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
  const { ownerIds, ownerList, displayFor, toggle, moveToRole, clearAll, currentUser } = owners;
  // Mounted only while the assignment menu is open (Radix unmounts Content
  // when closed). This is the team-roster collect that must not run for
  // every open conversation.
  const serverRoster = useOwnerCandidates(conversationId, currentUser);
  // Feed the roles slice while the menu is open, so a session filed under a
  // role names it and "Move to a role" can list the workspace's roles even off
  // the org page (org-staffing.md S11). Bounded to the menu's lifetime.
  useSyncOrgTreeFeeder();
  const { roles } = useOrgRoles();
  const liveRoles = roles.filter((r) => r.status !== "retired");
  const orgRoleId = useInboxStore((s) => {
    const live = (s as any).resolveLiveSessionId?.(conversationId) ?? conversationId;
    return ((s.sessions as any)?.[live]?.org_role_id ?? (s.conversations as any)?.[conversationId]?.org_role_id) as string | undefined;
  });
  const currentRole = orgRoleId ? liveRoles.find((r) => r._id === orgRoleId) : undefined;
  // A standing agent's own thread is a seat, not a hand: the server refuses to
  // file it under a role (sessionOwnership.performReparentSession), so the
  // menu does not offer it.
  const isStandingThread = useInboxStore((s) => {
    const live = (s as any).resolveLiveSessionId?.(conversationId) ?? conversationId;
    const row = (s.sessions as any)?.[live] ?? (s.conversations as any)?.[conversationId];
    return !!(row?.is_anchor || row?.anchor_id || row?.standing_role_id);
  });
  const selectable = pickRoster(serverRoster, owners.selectable).filter(
    (m: any) => m && !m.is_bot,
  );
  // Optional handoff note, sent along with the NEXT assignment made from this
  // menu. It rides the notification (push + inbox row) and the assignee's
  // "assigned to you" banner, then clears once used.
  const [note, setNote] = useState("");
  return (
    <>
      {/* The reporting line to a role (S11): the same act as a chart drag. When
          the session already reports to a role, name it; either way, offer to
          file it under a role, which clears the person-owner line. */}
      {currentRole && (
        <>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">
            Reports to a role
          </DropdownMenuLabel>
          <div className="px-2 pb-1 flex items-center gap-2 text-xs text-sol-text">
            <RoleFace role={currentRole} size={18} />
            <span className="truncate">{currentRole.name}</span>
            <span className="text-sol-text-dim font-mono text-[10px]">@{currentRole.handle}</span>
          </div>
        </>
      )}
      {moveToRole && !isStandingThread && liveRoles.length > 0 && (
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="text-xs gap-2">
              <Network className="w-3.5 h-3.5 shrink-0" /> Move to a role
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[280px] overflow-y-auto">
              {liveRoles.map((r) => (
                <DropdownMenuItem
                  key={r._id}
                  disabled={r._id === orgRoleId}
                  onSelect={(e) => { e.preventDefault(); void moveToRole(r._id, r.name); }}
                  className="text-xs gap-2"
                >
                  <RoleFace role={r} size={18} />
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="text-sol-text-dim font-mono text-[10px]">@{r.handle}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">
        Owners · whose inbox
      </DropdownMenuLabel>
      {currentUser && !currentUser.is_bot && !ownerIds.has(currentUser._id) && (
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); toggle(currentUser._id); }} className="text-xs gap-2 text-sol-cyan">
          <UserCheck className="w-3.5 h-3.5 shrink-0" />
          <span>Take ownership<span className="block text-[10px] text-sol-text-dim">Add to your inbox; keep existing owners</span></span>
        </DropdownMenuItem>
      )}
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

/**
 * The composer's hand-off picker: a teammate list with type-to-filter, opened
 * from the button beside the send arrow (or Alt+Shift+H). Picking a person
 * transfers the session to them with the composed text as the hand-off note —
 * one mutation (OwnersApi.handoffTo) — and the caller clears the composer. The
 * note is shown at the top so it is clear what travels with the assignment.
 *
 * "Stay an owner" keeps the session in the sender's inbox too; off by default,
 * because handing off means it is theirs now.
 */
export function HandoffPicker({
  owners,
  conversationId,
  note,
  open,
  onOpenChange,
  onPick,
  children,
}: {
  owners: OwnersApi;
  conversationId: string;
  note: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fires as soon as a teammate is chosen, before the mutation settles.
  onPick: (target: { id: string; name: string }, keepSelf: boolean) => void;
  children: ReactNode;
}) {
  const { currentUser, ownerIds } = owners;
  const serverRoster = useOwnerCandidates(conversationId, currentUser, open);
  const meId = currentUser?._id?.toString?.();
  const people = pickRoster(serverRoster, owners.selectable).filter(
    (m: any) => m && !m.is_bot && m._id !== meId,
  );
  const [keepSelf, setKeepSelf] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const preview = note.trim().split("\n").find((l) => l.trim()) ?? "";
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* An anchor, not a trigger: the button lives inside a tooltip wrapper
          that would swallow a trigger's cloned props, so it toggles `open`
          itself and the popover only positions against it. */}
      <PopoverAnchor asChild><span ref={anchorRef} className="inline-flex">{children}</span></PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="p-0 w-[320px] border-sol-border bg-sol-bg-alt text-sol-text shadow-xl"
        // Radix's Escape/outside dismissal closes; the composer refocuses its box.
        onKeyDown={(e) => e.stopPropagation()}
        // A click on the button itself is the toggle's job, not a dismissal —
        // otherwise the outside-click closes and the toggle reopens.
        onInteractOutside={(e) => { if (anchorRef.current?.contains(e.target as Node)) e.preventDefault(); }}
      >
        <div className="px-3 pt-2.5 pb-2 border-b border-sol-border/60">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-sol-violet">
            <ArrowRightLeft className="w-3 h-3" />
            Hand off to
          </div>
          {preview ? (
            <div className="mt-1 text-[11px] text-sol-text-muted truncate" title={note.trim()}>
              with your note: <span className="text-sol-text">“{preview}”</span>
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-sol-text-dim">
              No note — type a message first to send one along.
            </div>
          )}
        </div>
        <Command
          loop
          filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0)}
        >
          <CommandInput
            autoFocus
            placeholder="Find a teammate…"
            className="h-9 text-[13px] placeholder:text-sol-text-dim"
          />
          <CommandList className="max-h-[240px] py-1">
            <CommandEmpty className="py-5 text-center text-xs text-sol-text-dim">
              {people.length === 0 ? "No teammates on this session's team." : "Nobody matches."}
            </CommandEmpty>
            {people.map((m: any) => {
              const name = m.name || m.email?.split("@")[0] || "Teammate";
              const isOwner = ownerIds.has(m._id);
              return (
                <CommandItem
                  key={m._id}
                  value={`${name} ${m.email ?? ""}`}
                  onSelect={() => {
                    onOpenChange(false);
                    onPick({ id: m._id, name }, keepSelf);
                  }}
                  className="mx-1 gap-2.5 px-2 py-1.5 text-[13px] text-sol-text data-[selected=true]:bg-sol-violet/15 data-[selected=true]:text-sol-text [&[data-selected=true]_*]:text-inherit"
                >
                  <OwnerAvatar name={name} image={m.image || m.github_avatar_url} size="w-5 h-5" />
                  <span className="flex-1 min-w-0 truncate">{name}</span>
                  {isOwner && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-sol-text-dim">owner</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
        <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-sol-border/60">
          {/* Only an owner has anything to keep. */}
          {meId && ownerIds.has(meId) ? (
            <label className="flex items-center gap-2 text-[11px] text-sol-text-muted cursor-pointer select-none">
              <Switch checked={keepSelf} onCheckedChange={setKeepSelf} aria-label="Stay an owner" />
              Stay an owner
            </label>
          ) : <span />}
          <span className="flex items-center gap-1 text-[10px] text-sol-text-dim">
            <KeyCap size="xs">↵</KeyCap> hand off
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
