"use client";

/**
 * The owners segment of the header's runner pill and the menu it opens. A
 * session is in each owner's inbox: its people, and at most one role, which
 * is Active (it acts on the session) or Paused (a person's send paused it).
 * The segment draws the owners' faces in the order added, a paused role
 * greyed with a dashed ring; no face is ringed.
 *
 * The menu stages every change (remove, leave, add, resume) and applies
 * nothing until Save, which sends the whole change in one store action
 * (applySessionOwners), which paints it at once by the server's own rule.
 * Leaving a session that runs on your account first moves it to a team
 * machine, so it stays somewhere someone can see it.
 *
 * The model (hooks/useOwnersMenu) is the phone's too, highlight included;
 * this file draws it for a keyboard and a pointer. The arrows walk the
 * owners, then the candidates; Enter adds and Shift+Enter resumes a paused role. A
 * staged change survives a stray tap outside; Escape and Cancel discard it.
 */

import { useRef, useState, type KeyboardEvent } from "react";
import { Plus, Search, UserCheck, X, ChevronRight, BadgePlus } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwnerCandidates, pickRoster, type OwnersApi, type OwnerRole } from "../hooks/useOwners";
import { memberName, roleOwnerOf, useOwnersMenu, useOwnersView, type OwnerMenuRow, type OwnerPerson } from "../hooks/useOwnersMenu";
import { ownersTitle } from "../lib/coOwners";
import { useSessionRoleFacts } from "../hooks/useOwnersStoreEnv";
import { useSyncOrgTreeFeeder } from "../hooks/useSyncOrgTree";
import { useMoveTargets } from "../hooks/useBulkMoveSessions";
import { teamMembersOf } from "../lib/activeTeam";
import { isPerson } from "@codecast/shared/team/memberKind";
import { memberPresenceVisual, presenceLabel } from "./presence/memberPresence";
import { AssigneeFace } from "./identity/AssigneeFace";
import { RoleFace } from "./org/RoleFace";
import { deviceDisplayName, DeviceIcon, type Device } from "./DeviceBadge";
import type { OrgReportsTo } from "./org/orgTypes";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu";
import { sessionFitsARole } from "../lib/makeRole";
import { Button } from "./ui/button";
import { KeyCap } from "./KeyCap";
import { isMac } from "../shortcuts/registry";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { machineOf } from "../lib/ownersDraft";

const ROW = "group relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none modern:min-h-control-sm modern:gap-2 modern:rounded-control modern:px-2 modern:py-1 modern:text-ui data-[highlighted]:bg-accent modern:data-[highlighted]:bg-sol-cyan/10 own-row";
const LABEL = "px-2 py-1.5 font-semibold modern:px-2 modern:pb-1 modern:pt-2 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:text-sol-text-dim text-mark uppercase tracking-wide text-sol-text-dim";
const SEP = "-mx-1 my-1 h-px bg-muted modern:bg-sol-border/70";
const ICON_BTN = "shrink-0 p-0.5 rounded text-sol-text-dim";
const SHIFT_ENTER = isMac ? "⇧↵" : "Shift ↵";

export function Face({ person, role, size, paused }: { person?: OwnerPerson; role?: OwnerRole; size: number; paused?: boolean }) {
  const cls = paused ? "own-paused" : "";
  if (role) return <RoleFace role={{ _id: role.role_id, short_id: role.short_id, handle: role.handle, name: role.name, avatar: role.avatar }} size={size} className={cls} title={role.name} />;
  return <AssigneeFace info={{ name: person!.name, image: person!.image }} size={size} hover={false} className={cls} />;
}

/**
 * The header segment: owners' faces in a fixed order (people as added, then
 * the role), a paused role greyed. Click opens the menu.
 */
export function OwnersSegment({ conversationId, owners, compact }: { conversationId: string; owners: OwnersApi; compact: boolean }) {
  const [open, setOpen] = useState(false);
  // A staged change is kept from a stray outside tap; Escape still closes.
  const [dirty, setDirty] = useState(false);
  const { seatRoleId, currentRole: parentRole } = useSessionRoleFacts(conversationId);
  const { meId, people, role, driver } = useOwnersView(owners);
  const seat = !!seatRoleId;
  const paused = !!role && driver?.kind === "user";
  const title = seat && parentRole ? `Reports to ${parentRole.name}`
    : people.length || role ? ownersTitle(people.map((p) => (p._id === meId ? "You" : p.name)), role, paused)
      : "No owner: click to take ownership";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-owners-seg aria-haspopup="dialog" title={title} className={`inline-flex items-center gap-1 py-0.5 pl-1 pr-1.5 text-meta font-medium text-sol-text-dim hover:text-sol-text ${open ? "is-open" : ""}`}>
          {seat && parentRole ? (
            <><RoleFace role={parentRole} size={16} />{!compact && <span className="truncate cq-sq1 max-w-[120px]">{parentRole.name}</span>}</>
          ) : people.length === 0 && !role ? (
            <><UserCheck className="w-3.5 h-3.5" />{!compact && <span className="truncate cq-sq1">Take ownership</span>}</>
          ) : (
            <span className="own-stack">
              {people.slice(0, 3).map((p) => <Face key={p._id} person={p} size={16} />)}
              {people.length > 3 && <span className="text-meta tabular-nums">+{people.length - 3}</span>}
              {role && <Face role={role} size={16} paused={paused} />}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[23rem] max-w-[calc(100vw-2rem)] p-1" onOpenAutoFocus={(e) => e.preventDefault()} onInteractOutside={(e) => { if (dirty) e.preventDefault(); }}>
        {/* Keyed: a staged draft belongs to the session it was opened on. */}
        {seat ? <SeatReportsTo key={conversationId} conversationId={conversationId} owners={owners} onDone={() => setOpen(false)} /> : <OwnersMenuBody key={conversationId} conversationId={conversationId} owners={owners} onClose={() => { setDirty(false); setOpen(false); }} onDirty={setDirty} />}
      </PopoverContent>
    </Popover>
  );
}

function OwnersMenuBody({ conversationId, owners, onClose, onDirty }: { conversationId: string; owners: OwnersApi; onClose: () => void; onDirty: (dirty: boolean) => void }) {
  // Mounted only while the menu is open: the session team's roster and the
  // org's roles are subscribed for the menu's lifetime alone.
  useSyncOrgTreeFeeder();
  const m = useOwnersMenu(conversationId, owners);
  const { team: moveTargets } = useMoveTargets();
  const roster = useInboxStore(teamMembersOf) as any[];
  const menuRef = useRef<HTMLDivElement>(null);
  // Focus the search only for a precise pointer: on a touch screen it raises
  // the keyboard over the menu when the tap was for Resume or ×.
  const [autoFocusSearch] = useState(() => typeof window === "undefined" || !window.matchMedia || !window.matchMedia("(pointer: coarse)").matches);
  const searchRef = useRef<HTMLInputElement>(null);
  const { candidates, q, readOnly, highlighted, rows } = m;
  useWatchEffect(() => onDirty(m.dirty), [m.dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  // Follow the keyboard: the highlighted row stays in view.
  useWatchEffect(() => {
    if (highlighted >= 0) menuRef.current?.querySelector("[data-own-hi]")?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  // Only a mouse highlights: a touch screen's synthetic hover must not reveal
  // a button under the finger that is tapping the row.
  const hover = (i: number) => (e: { pointerType: string }) => { if (e.pointerType === "mouse") m.setHighlighted(i); };
  const highlight = (i: number) => (i === highlighted ? { "data-highlighted": "", "data-own-hi": "" } : {});
  const presenceOf = (id: string) => {
    const r = roster.find((x) => x._id === id);
    return r ? presenceLabel(memberPresenceVisual(r)) : null;
  };
  // Leaving puts the session on the machine's account: whose it is, face and
  // name, is the choice.
  const ownerOf = (d: any) => {
    const member = roster.find((x) => x._id === String(d.owner_user_id ?? ""));
    const name: string | null = member ? memberName(member) : d.runner_name ?? null;
    return { name, image: member?.image || member?.github_avatar_url };
  };
  const leaveTo = (device: Device & { owner_user_id?: string; is_bot?: boolean }) =>
    m.leaveTo({ device_id: device.device_id, is_remote: device.is_remote, label: machineOf(ownerOf(device).name, deviceDisplayName(device)), runner_id: String(device.owner_user_id ?? ""), runner_is_bot: !!device.is_bot });
  const save = () => { if (m.save()) onClose(); };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      m.move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter" && highlighted >= 0) {
      e.preventDefault();
      m.activate(e.shiftKey);
    }
  };

  const ownerRow = (r: OwnerMenuRow, i: number) => (
    <div key={r.key} className={ROW} data-owner-row={r.key} {...highlight(i)} onPointerEnter={hover(i)}>
      {r.role ? <Face role={r.role} size={20} paused={r.paused} /> : <Face person={r.person} size={20} />}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{r.name}</span>
        <span className={`truncate text-meta ${r.paused ? "text-sol-text-dim" : "text-sol-text-muted"}`}>{r.sub}</span>
      </span>
      {r.resume && !readOnly && <ResumeButton onClick={r.resume} />}
      {!readOnly && (
        <button type="button" onClick={r.onRemove ?? (() => { m.refuse(r); searchRef.current?.focus(); })} aria-disabled={!r.onRemove} title={r.removeLabel} aria-label={r.removeLabel} className={`${ICON_BTN} own-x ${r.onRemove ? "hover:text-sol-red hover:bg-sol-red/10" : "opacity-40 cursor-default"}`}>
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div onKeyDown={onKeyDown} data-owners-menu ref={menuRef}>
      <div className={LABEL}>Owners · whose inbox</div>
      {m.leaving && (
        <div className="mx-1 mb-1 rounded-md bg-sol-bg-highlight px-2 py-1.5" data-leave-box>
          <div className="text-meta text-sol-text-dim">Runs on your account. Move it to leave:</div>
          {moveTargets.length === 0 ? (
            <div className="py-1 text-meta text-sol-text-muted">No team machine to move it to</div>
          ) : moveTargets.map((d) => {
            const owner = ownerOf(d);
            return (
              <button key={d.device_id} type="button" onClick={() => leaveTo(d)} disabled={!d.online} data-leave-target={d.device_id} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-ui text-sol-text hover:bg-sol-bg-alt disabled:opacity-50">
                {owner.name ? <AssigneeFace info={{ name: owner.name, image: owner.image }} size={18} hover={false} /> : <DeviceIcon d={d} className="w-3.5 h-3.5" />}
                <span className="flex-1 truncate">{machineOf(owner.name, deviceDisplayName(d))}</span>
                <span className="text-meta text-sol-text-muted">{d.online ? "Move and leave" : "offline"}</span>
              </button>
            );
          })}
        </div>
      )}
      {m.rows.length === 0 && <div className="px-2 py-1 text-meta text-sol-text-dim">Nobody yet</div>}
      {rows.map(ownerRow)}
      {m.notice && <div className="px-2 py-1 text-meta text-sol-yellow" role="status" data-owners-notice>{m.notice}</div>}
      {m.canTakeOwnership && (
        <button type="button" data-take-ownership className={`${ROW} w-full text-sol-cyan`} onClick={() => { if (m.takeOwnership()) onClose(); }}>
          <UserCheck className="w-3.5 h-3.5" /> Take ownership
        </button>
      )}
      {!readOnly && <>
      <div className={SEP} />
      <label className="flex h-8 items-center gap-2 px-2 text-sol-text-dim">
        <Search className="w-3.5 h-3.5" />
        <input ref={searchRef} autoFocus={autoFocusSearch} value={m.query} onChange={(e) => m.setQuery(e.target.value)} placeholder={m.isStandingThread ? "Add a teammate" : "Add a role or teammate"} aria-label="Add a role or teammate" autoComplete="off" className="min-w-0 flex-1 bg-transparent text-ui text-sol-text placeholder:text-sol-text-dim outline-none" />
      </label>
      <div className="max-h-[320px] overflow-y-auto" data-owner-candidates>
        {m.shownRoles.length > 0 && <div className={LABEL}>{q ? "Roles" : "Suggested roles"}</div>}
        {candidates.map((c, i) => {
          const isRole = c.kind === "role";
          const name = isRole ? c.role.name : c.person.name;
          const presence = isRole ? null : presenceOf(c.person._id);
          const firstTeammate = !isRole && (i === 0 || candidates[i - 1].kind === "role");
          return (
            <div key={c.key}>
              {firstTeammate && (
                <>
                  {!q && !m.moreRoles && m.restRoles.length > 0 && (
                    <button type="button" className={`${ROW} w-full text-sol-text-muted`} onClick={() => m.setMoreRoles(true)}>
                      <ChevronRight className="w-3.5 h-3.5" /> {m.restRoles.length} more {m.restRoles.length === 1 ? "role" : "roles"}
                    </button>
                  )}
                  <div className={LABEL}>Teammates</div>
                  {m.unselected.length > 0 && (
                    <button type="button" data-select-all-teammates className={`${ROW} w-full text-sol-text-muted`} onClick={m.selectAllTeammates}>
                      <Plus className="w-3.5 h-3.5" /> Select all teammates
                      <span className="ml-auto text-meta tabular-nums text-sol-text-dim">{m.unselected.length}</span>
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
                {isRole ? <Face role={roleOwnerOf(c.role)} size={20} /> : <Face person={c.person} size={20} />}
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate">{name}</span>
                    {isRole && <span className="truncate font-mono text-meta text-sol-text-dim">@{c.role.handle}</span>}
                  </span>
                  {isRole && m.reasonOf(c.role) && <span className="truncate text-meta text-sol-text-dim" data-role-reason>{m.reasonOf(c.role)}</span>}
                  {presence && (
                    <span className="inline-flex items-center gap-1.5 text-meta text-sol-text-dim">
                      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${presence === "Active" ? "bg-sol-green" : "bg-sol-text-dim"}`} />{presence}
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
        {!q && !m.moreRoles && m.restRoles.length > 0 && m.teammates.length === 0 && (
          <button type="button" className={`${ROW} w-full text-sol-text-muted`} onClick={() => m.setMoreRoles(true)}>
            <ChevronRight className="w-3.5 h-3.5" /> {m.restRoles.length} more {m.restRoles.length === 1 ? "role" : "roles"}
          </button>
        )}
        {candidates.length === 0 && <div className="px-2 py-2 text-meta text-sol-text-dim">{q ? "Nobody matches" : "Nobody else to add"}</div>}
      </div>
      <div className={SEP} />
      <div className="flex items-center gap-2 px-1 py-1" data-owners-foot>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {m.chips.length ? m.chips.map((c) => <span key={c} className="own-chip">{c}</span>) : <span className="px-1 text-meta text-sol-text-dim">No changes</span>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="button" size="sm" disabled={!m.dirty} onClick={save} data-owners-save>
          Save <KeyCap size="xs" tone="onAccent">{isMac ? "⌘↵" : "Ctrl ↵"}</KeyCap>
        </Button>
      </div>
      </>}
    </div>
  );
}

/** A paused role's Resume, with its key: Shift+Enter on the highlighted row
 *  (the cap hides on a touch screen). */
function ResumeButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="xs" className="own-resume" onClick={onClick} data-owner-resume>
      Resume <KeyCap size="xs">{SHIFT_ENTER}</KeyCap>
    </Button>
  );
}

/**
 * A role's own session: one line, who the role reports to, which is whose
 * inbox it is in. Picking one moves the role (the chart's drag), so the chart
 * and the inbox can never disagree.
 */
function SeatReportsTo({ conversationId, owners, onDone }: { conversationId: string; owners: OwnersApi; onDone: () => void }) {
  const serverRoster = useOwnerCandidates(conversationId, owners.currentUser);
  useSyncOrgTreeFeeder();
  const { liveRoles, orgRoleId, seatRoleId } = useSessionRoleFacts(conversationId);
  const reparentOrgRole = useInboxStore((s) => (s as any).reparentOrgRole) as ((roleId: string, to: OrgReportsTo) => unknown) | undefined;
  const people = pickRoster(serverRoster, owners.selectable).filter(isPerson);
  const meId = owners.currentUser?._id?.toString?.();
  const pick = (to: OrgReportsTo) => { if (seatRoleId) reparentOrgRole?.(seatRoleId, to); onDone(); };
  return (
    <div data-seat-reports-to>
      <div className={LABEL}>Reports to · whose inbox</div>
      <div className="max-h-[320px] overflow-y-auto">
        {people.map((m: any) => {
          const on = !orgRoleId && owners.ownerList[0] === m._id;
          return (
            <button key={m._id} type="button" className={`${ROW} w-full ${on ? "font-medium" : ""}`} onClick={() => !on && pick({ kind: "user", user_id: m._id })}>
              <Face person={{ _id: m._id, name: memberName(m), image: m.image || m.github_avatar_url }} size={20} />
              <span className="flex-1 truncate text-left">{memberName(m)}{m._id === meId ? " (you)" : ""}</span>
            </button>
          );
        })}
        {liveRoles.filter((r) => r._id !== seatRoleId).map((r) => {
          const on = orgRoleId === r._id;
          return (
            <button key={r._id} type="button" className={`${ROW} w-full ${on ? "font-medium" : ""}`} onClick={() => !on && pick({ kind: "role", role_id: r._id })}>
              <Face role={roleOwnerOf(r)} size={20} />
              <span className="flex-1 truncate text-left">{r.name}</span>
              <span className="font-mono text-meta text-sol-text-dim">@{r.handle}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "Make this a role" (org-roles-run-work.md R2), in the machine menu: a
 * session older than a week may already be a role nobody has named. Read
 * once while the menu is open, which is why the clock read is fine here.
 */
export function MakeRoleMenuItem({ conversationId, onMakeRole }: { conversationId: string; onMakeRole: () => void }) {
  const fitsARole = useInboxStore((s) => {
    const live = s.resolveLiveSessionId(conversationId);
    return sessionFitsARole((s.sessions as any)?.[live] ?? (s.conversations as any)?.[conversationId], Date.now());
  });
  if (!fitsARole) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onMakeRole} className="text-xs gap-2" data-make-role>
        <BadgePlus className="w-3.5 h-3.5 shrink-0" />
        <span>Make this a role</span>
      </DropdownMenuItem>
    </>
  );
}
