"use client";

/**
 * The owners segment of the header's runner pill and the menu it opens, for
 * a session under the session_owners model. A session is in each owner's
 * inbox: its people, at most one role, and the session that started it. An
 * agent owner (the role, else that session) answers it for the people.
 *
 * The segment draws every owner's face in order: people as added, the role's
 * tile, the parent session's mark. No face is ringed.
 *
 * The menu stages every change (× on an owner, + on a candidate, Select all
 * teammates) and applies nothing until Save, which sends the whole change in
 * one store action (applySessionOwners) with the change that puts it back, so
 * its toast offers Undo. Arrows walk the owners then the candidates, Enter
 * adds, ⌘↵ saves, Escape closes. A staged change survives a stray tap outside.
 * A viewer who may not edit reads the owners, and may only add themselves.
 */

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Plus, Search, Users, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { teamMembersOf } from "../lib/activeTeam";
import { identityRowOf, identitySig } from "../lib/sessionIdentity";
import { applyOwnersWithToast, ownersTitle } from "../lib/ownersGestures";
import { useOwnersMenu, type OwnerMenuRow } from "../hooks/useOwnersMenu";
import { roleLikeOf, roleOwnerOf, shownParentOf, useSessionOwners, type OwnerPerson, type OwnerRoleFace, type SessionOwnersView } from "../hooks/useSessionOwners";
import { useSyncOrgTreeFeeder } from "../hooks/useSyncOrgTree";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { memberPresenceVisual, presenceLabel } from "./presence/memberPresence";
import { AssigneeFace } from "./identity/AssigneeFace";
import { SessionMark } from "./identity";
import { RoleFace } from "./org/RoleFace";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { DropdownMenuItem } from "./ui/dropdown-menu";
import { Button } from "./ui/button";
import { KeyCap } from "./KeyCap";
import { isMac } from "../shortcuts";
import { ownersModelOnFor, type SessionOwnersChange } from "../store/sessionOwnersSlice";

const ROW = "group relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none modern:min-h-control-sm modern:gap-2 modern:rounded-control modern:px-2 modern:py-1 modern:text-ui data-[highlighted]:bg-accent modern:data-[highlighted]:bg-sol-cyan/10 own-row";
const LABEL = "px-2 py-1.5 font-semibold modern:px-2 modern:pb-1 modern:pt-2 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:text-sol-text-dim text-mark uppercase tracking-wide text-sol-text-dim";
const SEP = "-mx-1 my-1 h-px bg-muted modern:bg-sol-border/70";
const ICON_BTN = "shrink-0 p-0.5 rounded text-sol-text-dim";

/** What a role does, for a role with no reason to be suggested: its charter's first line. */
const charterLine = (charter?: string) => charter?.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? null;

/** The face of the session that owns this one: its project mark. */
export function ParentSessionFace({ sessionId, title, size }: { sessionId: string; title: string; size: number }) {
  // The face's own fields, never the row: its ref flips on every heartbeat.
  const sig = useInboxStore((s: any) => markSigOf(s.sessions?.[sessionId] ?? s.conversations?.[sessionId]));
  const row = useMemo(() => markRowOf(sessionId, title, sig), [sessionId, title, sig]);
  return (
    <span title={title} className="inline-flex shrink-0" data-owner-session>
      <SessionMark session={row} size={size} iconClassName="w-3 h-3" />
    </span>
  );
}

const SEP_CHAR = "\u0000";
function markSigOf(row: any): string {
  return row ? [identitySig(row), row.agent_type ?? "", row.git_root ?? "", row.project_path ?? ""].join(SEP_CHAR) : "";
}
function markRowOf(sessionId: string, title: string, sig: string): any {
  if (!sig) return { _id: sessionId, title };
  const s = useInboxStore.getState() as any;
  const row = s.sessions?.[sessionId] ?? s.conversations?.[sessionId];
  return { ...identityRowOf(row), agent_type: row.agent_type, git_root: row.git_root, project_path: row.project_path };
}

export function OwnerFace({ person, role, size }: { person?: OwnerPerson; role?: OwnerRoleFace; size: number }) {
  if (role) return <RoleFace role={roleLikeOf(role)} size={size} title={role.name} />;
  return <AssigneeFace info={{ name: person!.name, image: person!.image }} size={size} hover={false} />;
}

/** "Owners: You, Ashot Petrosian, Eval Suite lead, <session>". */
/** Every owner's face, in order: people, the role, the parent session (unless
 *  it is the role's own standing session, which the role's face stands for). */
export function OwnerFaces({ view, size = 16 }: { view: SessionOwnersView; size?: number }) {
  const parent = shownParentOf(view);
  return (
    <span className="own-stack">
      {view.people.slice(0, 3).map((p) => <OwnerFace key={p._id} person={p} size={size} />)}
      {view.people.length > 3 && <span className="text-meta tabular-nums">+{view.people.length - 3}</span>}
      {view.role && <OwnerFace role={view.role} size={size} />}
      {parent && <ParentSessionFace sessionId={parent.id} title={parent.title} size={size} />}
    </span>
  );
}

/** The header segment: the owners' faces; a click opens the menu. */
export function OwnersSegment({ conversationId }: { conversationId: string }) {
  const view = useSessionOwners(conversationId);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  if (!view.on) return null;
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setDirty(false); }}>
      <PopoverTrigger asChild>
        <button type="button" data-owners-seg={conversationId} aria-haspopup="dialog" title={ownersTitle(view)} className={`inline-flex items-center gap-1 py-0.5 pl-1 pr-1.5 text-meta font-medium text-sol-text-dim hover:text-sol-text ${open ? "is-open" : ""}`}>
          <OwnerFaces view={view} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[23rem] max-w-[calc(100vw-2rem)] p-1" onOpenAutoFocus={(e) => e.preventDefault()} onInteractOutside={(e) => { if (dirty) e.preventDefault(); }}>
        {/* Keyed: a staged draft belongs to the session it was opened on. */}
        <OwnersMenuBody key={conversationId} conversationId={conversationId} view={view} onClose={() => { setDirty(false); setOpen(false); }} onDirty={setDirty} />
      </PopoverContent>
    </Popover>
  );
}

/** Whether the header shows this session's owners segment: present, sized,
 *  and inside the actions row that clips its leftmost pills when narrow. */
function ownersSegmentShown(conversationId: string): boolean {
  if (typeof document === "undefined") return true;
  const seg = [...document.querySelectorAll<HTMLElement>("[data-owners-seg]")].find((el) => el.dataset.ownersSeg === conversationId);
  if (!seg) return false;
  const r = seg.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const row = seg.closest("[data-cc-conv-actions]")?.getBoundingClientRect();
  return !row || (r.left >= row.left - 1 && r.right <= row.right + 1);
}

/**
 * "Owners" in the session menu, under the owners model, when the header is
 * too narrow to show the owners segment (a phone): it opens the same owners
 * menu as a bottom sheet. Read when the menu opens, which mounts this item.
 */
export function OwnersMenuItem({ conversationId, onOpen }: { conversationId: string; onOpen: () => void }) {
  const on = useInboxStore((s) => ownersModelOnFor(s as never, conversationId));
  // Off the model it reads no layout: whether the segment shows is asked only on it.
  return on ? <OwnersItemWhenHidden conversationId={conversationId} onOpen={onOpen} /> : null;
}

function OwnersItemWhenHidden({ conversationId, onOpen }: { conversationId: string; onOpen: () => void }) {
  const [hidden] = useState(() => !ownersSegmentShown(conversationId));
  if (!hidden) return null;
  return (
    <DropdownMenuItem onSelect={onOpen} data-owners-menu-item>
      <Users className="w-3 h-3 mr-1.5" />
      Owners
    </DropdownMenuItem>
  );
}

/** The owners menu as a bottom sheet, for a narrow header. */
export function OwnersSheet({ conversationId, open, onOpenChange }: { conversationId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const view = useSessionOwners(conversationId);
  const [dirty, setDirty] = useState(false);
  if (!view.on) return null;
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) setDirty(false); onOpenChange(o); }}>
      <SheetContent side="bottom" hideClose aria-describedby={undefined} className="p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] border-sol-border bg-sol-card" data-owners-sheet onOpenAutoFocus={(e) => e.preventDefault()} onInteractOutside={(e) => { if (dirty) e.preventDefault(); }}>
        <SheetTitle className="sr-only">Owners</SheetTitle>
        {open && <OwnersMenuBody key={conversationId} conversationId={conversationId} view={view} onClose={() => { setDirty(false); onOpenChange(false); }} onDirty={setDirty} touch />}
      </SheetContent>
    </Sheet>
  );
}

export function OwnersMenuBody({ conversationId, view, onClose, onDirty, touch = false }: { conversationId: string; view: SessionOwnersView; onClose: () => void; onDirty: (dirty: boolean) => void; /** A phone's sheet: no key caps. */ touch?: boolean }) {
  useSyncOrgTreeFeeder();
  const m = useOwnersMenu(conversationId, view, { open: true });
  const roster = useInboxStore(teamMembersOf) as any[];
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Focus the search only for a precise pointer: on a touch screen it raises
  // the keyboard over the menu when the tap was for × or +.
  const [autoFocusSearch] = useState(() => typeof window === "undefined" || !window.matchMedia || !window.matchMedia("(pointer: coarse)").matches);
  const { rows, candidates, highlighted, q } = m;
  useWatchEffect(() => onDirty(m.dirty), [m.dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useWatchEffect(() => {
    if (highlighted >= 0) menuRef.current?.querySelector("[data-own-hi]")?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  // Only a mouse highlights: a touch's synthetic hover must not move it.
  const hover = (i: number) => (e: { pointerType: string }) => { if (e.pointerType === "mouse") m.setHighlighted(i); };
  const highlight = (i: number) => (i === highlighted ? { "data-highlighted": "", "data-own-hi": "" } : {});
  const presenceOf = (member: any) => (member?.presence !== undefined || member?.last_seen_at !== undefined ? presenceLabel(memberPresenceVisual(member)) : null);
  const liveMember = (id: string) => roster.find((x) => String(x._id) === id);

  const save = () => {
    const label = m.chips.map((c) => (c.label === "You leave" ? "You left" : c.gone ? `${c.label} removed` : `${c.label.replace(/^\+ /, "")} added`)).join(" · ");
    if (m.save((change, inverse) => applyOwnersWithToast(conversationId, change, inverse, label))) onClose();
  };
  const addMe = () => {
    if (!m.meId) return;
    applyOwnersWithToast(conversationId, { add: [m.meId] }, { remove: [m.meId] }, "In your inbox");
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); m.move(e.key === "ArrowDown" ? 1 : -1); return; }
    if (e.key === "Enter" && m.activate()) e.preventDefault();
  };

  const ownerRow = (r: OwnerMenuRow, i: number) => (
    <div key={r.key} className={ROW} data-owner-row={r.key} {...highlight(i)} onPointerEnter={hover(i)}>
      {r.kind === "session" ? <ParentSessionFace sessionId={r.key.slice(2)} title={r.name} size={20} /> : <OwnerFace person={r.person} role={r.role} size={20} />}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{r.name}</span>
        <span className="truncate text-meta text-sol-text-dim">{r.sub}</span>
      </span>
      {!m.readOnly && (
        <button type="button" disabled={!r.onRemove} onClick={r.onRemove ?? undefined} title={r.removeLabel} aria-label={r.removeLabel} className={`${ICON_BTN} own-x ${r.onRemove ? "hover:text-sol-red hover:bg-sol-red/10" : "opacity-30"}`}>
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );

  const moreRolesRow = !q && m.restRoles.length > 0 && (
    <button type="button" data-more-roles className={`${ROW} w-full text-sol-text-muted`} onClick={() => m.setMoreRoles(!m.moreRoles)}>
      {m.moreRoles ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      {m.moreRoles ? "Only suggested roles" : `${m.restRoles.length} more ${m.restRoles.length === 1 ? "role" : "roles"}`}
    </button>
  );

  return (
    <div onKeyDown={onKeyDown} data-owners-menu ref={menuRef} role="dialog" aria-label="Owners">
      <div className={LABEL}>Owners · whose inbox</div>
      {rows.map(ownerRow)}
      {m.notice && <div className="px-2 py-1 text-meta text-sol-yellow" role="status" data-owners-notice>{m.notice}</div>}
      {m.readOnly ? (
        !view.mine && m.meId && (
          <>
            <div className={SEP} />
            <button type="button" data-owners-add-me className={`${ROW} w-full text-sol-cyan`} onClick={addMe}>
              <Plus className="w-3.5 h-3.5" /> Add me
            </button>
          </>
        )
      ) : <>
        <div className={SEP} />
        <label className="flex h-8 items-center gap-2 px-2 text-sol-text-dim">
          <Search className="w-3.5 h-3.5" />
          <input ref={searchRef} autoFocus={autoFocusSearch} value={m.query} onChange={(e) => m.setQuery(e.target.value)} placeholder={m.isStandingThread ? "Add a teammate" : "Add a role or teammate"} aria-label="Add a role or teammate" autoComplete="off" className="min-w-0 flex-1 bg-transparent text-ui text-sol-text placeholder:text-sol-text-dim outline-none" />
        </label>
        <div className="max-h-[320px] overflow-y-auto" data-owner-candidates>
          {candidates.map((c, i) => {
            const isRole = c.kind === "role";
            const name = isRole ? c.role.name : c.person.name;
            const reason = isRole ? (!q && !m.moreRoles ? m.reasonOf(c.role) : null) ?? charterLine(c.role.charter) : null;
            const member = isRole ? null : liveMember(c.person._id) ?? c.member;
            const presence = member ? presenceOf(member) : null;
            const firstTeammate = !isRole && i === 0;
            const firstRole = isRole && (i === 0 || candidates[i - 1].kind === "person");
            return (
              <div key={c.key}>
                {firstRole && <div className={LABEL}>{q || m.moreRoles ? "Roles" : "Suggested roles"}</div>}
                {firstTeammate && (
                  <>
                    <div className={LABEL}>Teammates</div>
                    {!q && m.unselected.length > 1 && (
                      <button type="button" data-select-all-teammates className={`${ROW} w-full text-sol-text-muted`} onClick={m.selectAllTeammates}>
                        <Users className="w-3.5 h-3.5" /> <span className="flex-1 text-left">Select all teammates</span>
                        <span className="text-meta tabular-nums text-sol-text-dim">{m.unselected.length}</span>
                      </button>
                    )}
                  </>
                )}
                <div
                  role="menuitemcheckbox"
                  aria-checked={false}
                  className={`${ROW} own-cand`}
                  data-owner-candidate={c.key}
                  {...highlight(rows.length + i)}
                  onPointerEnter={hover(rows.length + i)}
                  onClick={() => m.add(c)}
                >
                  {isRole ? <OwnerFace role={roleOwnerOf(c.role)} size={20} /> : <OwnerFace person={c.person} size={20} />}
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate">{name}</span>
                      {isRole && <span className="truncate font-mono text-meta text-sol-text-dim">@{c.role.handle}</span>}
                    </span>
                    {reason && <span className="truncate text-meta text-sol-text-dim" data-role-reason>{reason}</span>}
                    {presence && (
                      <span className="inline-flex items-center gap-1.5 text-meta text-sol-text-dim">
                        <span className={`inline-flex h-1.5 w-1.5 rounded-full ${presence === "Online" ? "bg-sol-green" : "bg-sol-text-dim"}`} />{presence}
                      </span>
                    )}
                  </span>
                  <button type="button" className={`${ICON_BTN} hover:text-sol-text own-plus`} title={`Add ${name}`} aria-label={`Add ${name}`} onClick={(e) => { e.stopPropagation(); m.add(c); }}>
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
          {moreRolesRow}
          {candidates.length === 0 && <div className="px-2 py-2 text-meta text-sol-text-dim">{q ? `Nobody called “${m.query.trim()}”` : "Nobody else to add"}</div>}
        </div>
        <div className={SEP} />
        <div className="flex items-center gap-2 px-1 py-1" data-owners-foot>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {m.chips.length ? m.chips.map((c) => (
              <span key={c.key} className={`own-chip ${c.gone ? "line-through decoration-sol-text-dim" : ""}`}>
                {c.face.session ? null : <OwnerFace person={c.face.person} role={c.face.role} size={14} />}
                <span data-chip-label>{c.label}</span>
              </span>
            )) : <span className="px-1 text-meta text-sol-text-dim">No changes</span>}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" disabled={!m.dirty} onClick={save} data-owners-save>
            Save{!touch && <KeyCap size="xs" tone="onAccent">{isMac ? "⌘↵" : "Ctrl ↵"}</KeyCap>}
          </Button>
        </div>
      </>}
    </div>
  );
}
