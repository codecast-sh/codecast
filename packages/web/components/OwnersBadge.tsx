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
import { toast } from "sonner";
import { X, UserCheck, ArrowRightLeft, ArrowLeft, Network, BadgePlus } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwners, useOwnerCandidates, pickRoster, type OwnersApi, type HandoffInfo } from "../hooks/useOwners";
import { useStoreOwnersEnv, useSessionRoleFacts } from "../hooks/useOwnersStoreEnv";
import { useSyncOrgTreeFeeder } from "../hooks/useSyncOrgTree";
import { RoleFace } from "./org/RoleFace";
import type { OrgReportsTo, OrgRole } from "./org/orgTypes";
import { RoleHoverCard } from "./identity/RoleHoverCard";
import { PersonHoverCard } from "./identity/PersonHoverCard";
import { sessionFitsARole } from "../lib/makeRole";
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
import { isPerson } from "@codecast/shared/team/memberKind";
import { Button } from "./ui/button";

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
  return useOwners(conversationId, useStoreOwnersEnv(conversationId, {
    teamMembers,
    currentUser,
    notify: (msg, kind) => (kind === "success" ? toast.success(msg) : toast.error(msg)),
  }));
}

/**
 * The owners section of an assignment popover: the role line, then who owns
 * the session and the hand-off step (OwnersSection). Drop inside an open
 * DropdownMenuContent; `onDone` closes that menu once a hand-off is sent.
 */
export function OwnerMenuItems({
  owners,
  conversationId,
  onMakeRole,
  handingOff,
  onHandingOff,
  onDone,
}: {
  owners: OwnersApi;
  conversationId: string;
  /** The hand-off step is open: it takes the whole menu. */
  handingOff: boolean;
  onHandingOff: (on: boolean) => void;
  onDone: () => void;
  /** Opens "Make this a role" (R2). The dialog lives outside the menu, which
   *  unmounts its content when it closes. */
  onMakeRole?: () => void;
}) {
  const { ownerList, moveToRole, currentUser } = owners;
  // Mounted only while the assignment menu is open (Radix unmounts Content
  // when closed). This is the team-roster collect that must not run for
  // every open conversation.
  const serverRoster = useOwnerCandidates(conversationId, currentUser);
  // Feed the roles slice while the menu is open, so a session filed under a
  // role names it and "Move to a role" can list the workspace's roles even off
  // the org page (org-staffing.md S11). Bounded to the menu's lifetime.
  useSyncOrgTreeFeeder();
  const { liveRoles, orgRoleId, currentRole, isStandingThread, seatRoleId } = useSessionRoleFacts(conversationId);
  const reparentOrgRole = useInboxStore((s) => (s as any).reparentOrgRole) as ((roleId: string, to: OrgReportsTo) => unknown) | undefined;
  // A session older than a week may already be a role nobody has named
  // (org-roles-run-work.md R2); the analyzer proposes those it finds, and this
  // is the way to name one it left out. Read once: the menu is short lived.
  const fitsARole = useInboxStore((s) => {
    const live = (s as any).resolveLiveSessionId?.(conversationId) ?? conversationId;
    return sessionFitsARole((s.sessions as any)?.[live] ?? (s.conversations as any)?.[conversationId], Date.now());
  });
  const selectable = pickRoster(serverRoster, owners.selectable).filter(isPerson);
  return (
    <>
      {seatRoleId && reparentOrgRole ? (
        <SeatReportsToItems
          people={selectable}
          currentUserId={currentUser?._id}
          ownerId={ownerList[0]}
          roles={liveRoles.filter((r) => r._id !== seatRoleId)}
          parentRoleId={orgRoleId}
          onPick={(to) => reparentOrgRole(seatRoleId, to)}
        />
      ) : (
        <OwnersSection owners={owners} people={selectable} handingOff={handingOff} onHandingOff={onHandingOff} onDone={onDone} />
      )}
      {!handingOff && (<>
      {/* The reporting line to a role (S11): the same act as a chart drag. When
          the session already reports to a role, name it; either way, offer to
          file it under a role, which clears the person-owner line. */}
      {currentRole && !seatRoleId && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">
            Reports to a role
          </DropdownMenuLabel>
          <div className="px-2 pb-1 text-xs text-sol-text">
            {/* What the role looks after is one hover away (org-roles-run-work.md R3). */}
            <RoleHoverCard role={currentRole} side="left" triggerClassName="inline-flex min-w-0 items-center gap-2">
              <RoleFace role={currentRole} size={18} />
              <span className="truncate">{currentRole.name}</span>
              <span className="text-sol-text-dim font-mono text-[10px]">@{currentRole.handle}</span>
            </RoleHoverCard>
          </div>
        </>
      )}
      {moveToRole && !isStandingThread && liveRoles.length > 0 && (
        <>
          {!currentRole && <DropdownMenuSeparator />}
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
                  {/* Before a person files a session under a role, its scope is a hover away. */}
                  <RoleHoverCard role={r} side="right" triggerClassName="flex flex-1 min-w-0 items-center gap-2">
                    <RoleFace role={r} size={18} />
                    <span className="flex-1 truncate">{r.name}</span>
                    <span className="text-sol-text-dim font-mono text-[10px]">@{r.handle}</span>
                  </RoleHoverCard>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      )}
      {onMakeRole && fitsARole && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onMakeRole} className="text-xs gap-2" data-make-role>
            <BadgePlus className="w-3.5 h-3.5 shrink-0" />
            <span>Make this a role<span className="block text-[10px] text-sol-text-dim">It keeps running as it is, and gets a name and a place on the chart</span></span>
          </DropdownMenuItem>
        </>
      )}
      </>)}
    </>
  );
}

const memberName = (m: any) => m.name || m.email?.split("@")[0] || "Teammate";
const memberImage = (m: any) => m.image || m.github_avatar_url;

/**
 * Who owns the session, and handing it to someone. Two steps in one place:
 * the owner list (each removable) with a Hand off button, and the hand-off
 * step, where a person is picked, a note written, and one press sends both
 * (OwnersApi.handoffTo, the composer's path). The picked person and the
 * button's own label say what will happen before it does.
 */
function OwnersSection({ owners, people, handingOff, onHandingOff, onDone }: {
  owners: OwnersApi;
  people: any[];
  handingOff: boolean;
  onHandingOff: (on: boolean) => void;
  onDone: () => void;
}) {
  const { ownerList, ownerIds, displayFor, toggle, currentUser } = owners;
  const meId = currentUser?._id?.toString?.();
  const others = people.filter((m) => m._id !== meId);
  if (handingOff) {
    return <HandoffStep owners={owners} people={others} onBack={() => onHandingOff(false)} onSent={onDone} />;
  }
  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">
        Owners · whose inbox
      </DropdownMenuLabel>
      {ownerList.length === 0 && (
        <div className="px-2 py-1 text-xs text-sol-text-dim">Nobody yet</div>
      )}
      {ownerList.map((id) => {
        const disp = id === meId && isPerson(currentUser) ? { name: memberName(currentUser), image: memberImage(currentUser) } : displayFor(id);
        return (
          <div key={id} className="group flex items-center gap-2 px-2 py-1 text-xs text-sol-text">
            <OwnerAvatar name={disp.name} image={disp.image} size="w-5 h-5" />
            <span className="flex-1 truncate">{disp.name}{id === meId ? " (you)" : ""}</span>
            <button
              type="button"
              onClick={() => toggle(id)}
              title={id === meId ? "Leave: take it out of your inbox" : `Remove ${disp.name}`}
              aria-label={id === meId ? "Leave" : `Remove ${disp.name}`}
              className="shrink-0 p-0.5 rounded text-sol-text-dim opacity-40 group-hover:opacity-100 hover:text-sol-red hover:bg-sol-red/10 transition-opacity"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
      {isPerson(currentUser) && meId && !ownerIds.has(meId) && (
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); toggle(meId); }} className="text-xs gap-2 text-sol-cyan">
          <UserCheck className="w-3.5 h-3.5 shrink-0" /> Take ownership
        </DropdownMenuItem>
      )}
      {others.length > 0 && (
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); onHandingOff(true); }}
          className="mx-1 my-1 justify-center gap-2 rounded-md border border-sol-violet/40 bg-sol-violet/10 py-1.5 text-xs font-medium text-sol-violet focus:bg-sol-violet/20 focus:text-sol-violet"
          data-handoff-open
        >
          <ArrowRightLeft className="w-3.5 h-3.5 shrink-0" /> Hand off…
        </DropdownMenuItem>
      )}
    </>
  );
}

/** Pick one person, write a note, send. Plain buttons rather than menu items,
 *  so a pointer passing over the list does not pull focus out of the note. */
function HandoffStep({ owners, people, onBack, onSent }: {
  owners: OwnersApi;
  people: any[];
  onBack: () => void;
  onSent: () => void;
}) {
  const { ownerIds, handoffTo, currentUser } = owners;
  const meId = currentUser?._id?.toString?.();
  const [pickedId, setPickedId] = useState<string | null>(people.length === 1 ? people[0]._id : null);
  const [note, setNote] = useState("");
  const [keepSelf, setKeepSelf] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const picked = people.find((m) => m._id === pickedId);
  const firstName = picked ? memberName(picked).split(" ")[0] : "";
  const send = () => {
    if (!picked) return;
    void handoffTo(picked._id, note, { keepSelf });
    onSent();
  };
  return (
    <div
      // Keys belong to the step: the menu's typeahead and arrow handling would
      // otherwise swallow letters typed into the note.
      onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}
      className="px-1 pb-1"
      data-handoff-step
    >
      <div className="flex items-center gap-1.5 px-1 pt-1 pb-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to owners"
          className="p-0.5 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-sol-violet">Hand off to</span>
      </div>
      <div role="radiogroup" aria-label="Hand off to" className="max-h-[220px] overflow-y-auto">
        {people.map((m) => {
          const on = m._id === pickedId;
          return (
            <button
              key={m._id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => { setPickedId(m._id); noteRef.current?.focus(); }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors ${
                on ? "bg-sol-violet/15 text-sol-text ring-1 ring-inset ring-sol-violet/50" : "text-sol-text hover:bg-sol-bg-highlight"
              }`}
            >
              <OwnerAvatar name={memberName(m)} image={memberImage(m)} size="w-5 h-5" />
              <span className="flex-1 truncate">{memberName(m)}</span>
              {ownerIds.has(m._id) && <span className="shrink-0 text-[9px] uppercase tracking-wide text-sol-text-dim">owner</span>}
              <span className={`shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center ${on ? "border-sol-violet bg-sol-violet" : "border-sol-border"}`}>
                {on && <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />}
              </span>
            </button>
          );
        })}
      </div>
      <textarea
        ref={noteRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        rows={2}
        placeholder={picked ? `Note for ${firstName} (optional)` : "Note (optional)"}
        className="mt-1.5 w-full resize-none px-2 py-1.5 text-xs rounded-md border border-sol-border/60 bg-sol-bg text-sol-text placeholder:text-sol-text-dim/70 outline-none focus:border-sol-violet/60"
      />
      <div className="mt-1.5 flex items-center gap-2">
        {/* Only an owner has anything to keep. */}
        {meId && ownerIds.has(meId) && (
          <label className="flex items-center gap-1.5 text-[11px] text-sol-text-muted cursor-pointer select-none">
            <Switch checked={keepSelf} onCheckedChange={setKeepSelf} aria-label="Stay an owner" />
            Stay an owner
          </label>
        )}
        <Button type="button" variant="violet" size="xs" disabled={!picked} onClick={send} className="ml-auto">
          {picked ? `Hand off to ${firstName}` : "Pick someone"}
          {picked && <KeyCap size="xs">↵</KeyCap>}
        </Button>
      </div>
    </div>
  );
}

/** A role's own session: one line, who the role reports to, which is whose
 *  inbox it is in. People and roles sit in one list, each a hover away from
 *  who it is. Picking one moves the role (the chart's drag), so the chart and
 *  the inbox can never disagree. */
function SeatReportsToItems({ people, currentUserId, ownerId, roles, parentRoleId, onPick }: {
  people: any[];
  currentUserId?: string;
  ownerId?: string;
  roles: OrgRole[];
  parentRoleId?: string;
  onPick: (to: OrgReportsTo) => void;
}) {
  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">
        Reports to · whose inbox
      </DropdownMenuLabel>
      <div className="max-h-[320px] overflow-y-auto">
        {people.map((m: any) => {
          const name = m.name || m.email?.split("@")[0];
          return (
            <DropdownMenuCheckboxItem
              key={m._id}
              checked={!parentRoleId && ownerId === m._id}
              onSelect={() => { if (parentRoleId || ownerId !== m._id) onPick({ kind: "user", user_id: m._id }); }}
              className="text-xs gap-2"
            >
              <PersonHoverCard person={{ userId: m._id, handle: m.github_username, name, image: m.image || m.github_avatar_url }} side="left" triggerClassName="flex flex-1 min-w-0 items-center gap-2">
                <OwnerAvatar name={name || "?"} image={m.image || m.github_avatar_url} />
                <span className="flex-1 truncate">{name}{m._id === currentUserId ? " (you)" : ""}</span>
              </PersonHoverCard>
            </DropdownMenuCheckboxItem>
          );
        })}
        {roles.map((r) => (
          <DropdownMenuCheckboxItem key={r._id} checked={parentRoleId === r._id} onSelect={() => { if (parentRoleId !== r._id) onPick({ kind: "role", role_id: r._id }); }} className="text-xs gap-2">
            <RoleHoverCard role={r} side="left" triggerClassName="flex flex-1 min-w-0 items-center gap-2">
              <RoleFace role={r} size={16} />
              <span className="flex-1 truncate">{r.name}</span>
              <span className="text-sol-text-dim font-mono text-[10px]">@{r.handle}</span>
            </RoleHoverCard>
          </DropdownMenuCheckboxItem>
        ))}
      </div>
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
