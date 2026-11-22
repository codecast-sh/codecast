"use client";

/**
 * Web bindings for the OWNERS axis of a session (whose inboxes it appears in).
 * The platform-free logic lives in hooks/useOwners (shared with mobile); this
 * file adds the inbox-store roster + sonner toasts (useOwnersFromStore), the
 * assigned-to-you banner and the composer's hand-off picker. The header's
 * owners segment and menu live in OwnersMenu.
 */

import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { UserCheck, ArrowRightLeft } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwners, useOwnerCandidates, pickRoster, type OwnersApi, type HandoffInfo } from "../hooks/useOwners";
import { useStoreOwnersEnv } from "../hooks/useOwnersStoreEnv";
import { AvatarImg } from "../lib/avatarCache";
import { formatRelative, formatDateFull } from "../lib/utils";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from "./ui/command";
import { Switch } from "./ui/switch";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { isPerson } from "@codecast/shared/team/memberKind";
import { teamMembersOf } from "../lib/activeTeam";

export type { OwnersApi, HandoffInfo };

export function OwnerAvatar({ name, image, size = "w-4 h-4" }: { name: string; image?: string; size?: string }) {
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <AvatarImg
      src={image}
      alt={name}
      className={`${size} rounded-full object-cover`}
      fallback={
        <div className={`${size} rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-meta font-medium text-sol-text-muted`}>
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
  const teamMembers = useInboxStore(teamMembersOf) as any[];
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  return useOwners(conversationId, useStoreOwnersEnv(conversationId, {
    teamMembers,
    currentUser,
    notify: (msg, kind) => (kind === "success" ? toast.success(msg) : toast.error(msg)),
  }));
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
        className="flex-shrink-0 px-2.5 py-1 rounded-md text-meta font-medium bg-sol-violet/20 text-sol-violet border border-sol-violet/40 hover:bg-sol-violet/30 transition-colors"
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
    (m: any) => isPerson(m) && m._id !== meId,
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
          <div className="flex items-center gap-1.5 text-mark font-semibold uppercase tracking-[0.15em] text-sol-violet">
            <ArrowRightLeft className="w-3 h-3" />
            Hand off to
          </div>
          {preview ? (
            <div className="mt-1 text-meta text-sol-text-muted truncate" title={note.trim()}>
              with your note: <span className="text-sol-text">“{preview}”</span>
            </div>
          ) : (
            <div className="mt-1 text-meta text-sol-text-dim">
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
                    <span className="shrink-0 text-mark uppercase tracking-wide text-sol-text-dim">owner</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
        <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-sol-border/60">
          {/* Only an owner has anything to keep. */}
          {meId && ownerIds.has(meId) ? (
            <label className="flex items-center gap-2 text-meta text-sol-text-muted cursor-pointer select-none">
              <Switch checked={keepSelf} onCheckedChange={setKeepSelf} aria-label="Stay an owner" />
              Stay an owner
            </label>
          ) : <span />}
          <span className="flex items-center gap-1 text-meta text-sol-text-dim">
            <KeyCap size="xs">↵</KeyCap> hand off
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
