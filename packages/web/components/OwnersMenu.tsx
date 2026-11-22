"use client";

/**
 * The owners segment of the header's runner pill and the menu it opens. A
 * session is in each owner's inbox: its people, and at most one role. Exactly
 * one owner drives (messages the agent): the role while it is filed and no
 * person has taken over, else that person. The segment draws the owners'
 * faces in the order added, the driver ringed and a paused role greyed.
 *
 * The menu stages every change (remove, leave, add, make driver) and applies
 * nothing until Save, which sends the whole change in one store action
 * (applySessionOwners) and paints it at once through useOwners' pending view.
 * Leaving a session that runs on your account first moves it to a team
 * machine, so it stays somewhere someone can see it.
 */

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Plus, Search, UserCheck, X, ChevronRight, BadgePlus } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwnerCandidates, pickRoster, type OwnersApi, type OwnerRole, type SessionDriver } from "../hooks/useOwners";
import { addPerson, addRole, diffOwners, driverKey, leave, removePerson, removeRole, type OwnersDraft } from "../lib/ownersDraft";
import { useSessionRoleFacts } from "../hooks/useOwnersStoreEnv";
import { useSyncOrgTreeFeeder } from "../hooks/useSyncOrgTree";
import { useMoveTargets } from "../hooks/useBulkMoveSessions";
import { requestSessionMove } from "../lib/sessionCommands";
import { teamMembersOf } from "../lib/activeTeam";
import { isPerson } from "@codecast/shared/team/memberKind";
import { memberPresenceVisual, presenceLabel } from "./presence/memberPresence";
import { AssigneeFace } from "./identity/AssigneeFace";
import { RoleFace } from "./org/RoleFace";
import { deviceDisplayName, DeviceIcon, type Device } from "./DeviceBadge";
import type { OrgReportsTo, OrgRole } from "./org/orgTypes";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu";
import { sessionFitsARole } from "../lib/makeRole";
import { Button } from "./ui/button";
import { KeyCap } from "./KeyCap";
import { isMac } from "../shortcuts/registry";

const ROW = "group relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none modern:min-h-control-sm modern:gap-2 modern:rounded-control modern:px-2 modern:py-1 modern:text-ui data-[highlighted]:bg-accent modern:data-[highlighted]:bg-sol-cyan/10 own-row";
const LABEL = "px-2 py-1.5 font-semibold modern:px-2 modern:pb-1 modern:pt-2 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:text-sol-text-dim text-mark uppercase tracking-wide text-sol-text-dim";
const SEP = "-mx-1 my-1 h-px bg-muted modern:bg-sol-border/70";
const ICON_BTN = "shrink-0 p-0.5 rounded text-sol-text-dim";
const SUGGESTED_ROLES = 3;

type Person = { _id: string; name: string; image?: string };
type Candidate = { key: string; kind: "person"; person: Person } | { key: string; kind: "role"; role: OrgRole };

const memberName = (m: any): string => m?.name || m?.email?.split("@")[0] || "Teammate";
const roleOwnerOf = (r: OrgRole): OwnerRole => ({ role_id: r._id, short_id: r.short_id, handle: r.handle, name: r.name, avatar: (r as any).avatar ?? null });
const isDriver = (d: SessionDriver | null, key: string) => driverKey(d) === key;

function Face({ person, role, size, driver, paused }: { person?: Person; role?: OwnerRole; size: number; driver?: boolean; paused?: boolean }) {
  const cls = `${driver ? "own-drv" : ""} ${paused ? "own-paused" : ""}`;
  if (role) return <RoleFace role={{ _id: role.role_id, short_id: role.short_id, handle: role.handle, name: role.name, avatar: role.avatar }} size={size} className={cls} title={role.name} />;
  return <AssigneeFace info={{ name: person!.name, image: person!.image }} size={size} hover={false} className={cls} />;
}

/** The current view (people, role, driver) the segment and the menu start from. */
function useOwnersView(owners: OwnersApi) {
  const { ownerList, displayFor, currentUser, role, driver } = owners;
  const meId = currentUser?._id?.toString?.();
  const people: Person[] = ownerList.map((id) => {
    if (id === meId && currentUser) return { _id: id, name: memberName(currentUser), image: currentUser.image || currentUser.github_avatar_url };
    const d = displayFor(id);
    return { _id: id, name: d.name, image: d.image };
  });
  return { meId, people, role, driver };
}

/**
 * The header segment: owners' faces in a fixed order (people as added, then
 * the role), the driver ringed, a paused role greyed. Click opens the menu.
 */
export function OwnersSegment({ conversationId, owners, compact }: { conversationId: string; owners: OwnersApi; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const { seatRoleId, currentRole: parentRole } = useSessionRoleFacts(conversationId);
  const { people, role, driver } = useOwnersView(owners);
  const seat = !!seatRoleId;
  const paused = !!role && driver?.kind === "user";
  const names = [...people.map((p) => (isDriver(driver, `p:${p._id}`) ? `${p.name} (driver)` : p.name)), ...(role ? [`${role.name}${paused ? " (paused)" : driver?.kind === "role" ? " (driver)" : ""}`] : [])];
  const title = seat && parentRole ? `Reports to ${parentRole.name}` : names.length ? `Owners: ${names.join(", ")}` : "No owner: click to take ownership";
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
              {people.slice(0, 3).map((p) => <Face key={p._id} person={p} size={16} driver={isDriver(driver, `p:${p._id}`)} />)}
              {people.length > 3 && <span className="text-meta tabular-nums">+{people.length - 3}</span>}
              {role && <Face role={role} size={16} driver={driver?.kind === "role"} paused={paused} />}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[23rem] max-w-[calc(100vw-2rem)] p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
        {seat ? <SeatReportsTo conversationId={conversationId} owners={owners} onDone={() => setOpen(false)} /> : <OwnersMenuBody conversationId={conversationId} owners={owners} onClose={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function OwnersMenuBody({ conversationId, owners, onClose }: { conversationId: string; owners: OwnersApi; onClose: () => void }) {
  // Mounted only while the menu is open: the session team's roster and the
  // org's roles are subscribed for the menu's lifetime alone.
  const serverRoster = useOwnerCandidates(conversationId, owners.currentUser);
  useSyncOrgTreeFeeder();
  const { liveRoles, isStandingThread } = useSessionRoleFacts(conversationId);
  const { team: moveTargets } = useMoveTargets();
  const roster = useInboxStore(teamMembersOf) as any[];
  const sessionWork = useInboxStore((s) => {
    const row = (s.sessions as any)?.[s.resolveLiveSessionId(conversationId)] ?? (s.conversations as any)?.[conversationId];
    return `${row?.project_id ?? ""}|${row?.active_plan?._id ?? ""}`;
  });
  const { meId, people: initialPeople, role: initialRole, driver: initialDriver } = useOwnersView(owners);
  const runsOnMine = !!meId && owners.runner?.user_id === meId;

  // Until the first edit the menu follows the live owners; the first edit
  // freezes what it started from, which Save diffs against.
  const live: OwnersDraft = { ownerIds: initialPeople.map((p) => p._id), role: initialRole, driver: initialDriver, moveTo: null };
  const [edit, setEdit] = useState<{ initial: OwnersDraft; draft: OwnersDraft } | null>(null);
  const initial = edit?.initial ?? live;
  const draft = edit?.draft ?? live;
  const setDraft = (f: (d: OwnersDraft) => OwnersDraft) => setEdit((e) => ({ initial: e?.initial ?? live, draft: f(e?.draft ?? live) }));
  const [query, setQuery] = useState("");
  const [moreRoles, setMoreRoles] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [hi, setHi] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const people = pickRoster(serverRoster, owners.selectable).filter(isPerson);
  const personById = useMemo(() => {
    const m = new Map<string, Person>();
    for (const p of initialPeople) m.set(p._id, p);
    for (const p of people) m.set(p._id, { _id: p._id, name: memberName(p), image: p.image || p.github_avatar_url });
    return m;
  }, [initialPeople, people]);
  const personOf = (id: string): Person => personById.get(id) ?? { _id: id, name: owners.displayFor(id).name };

  const q = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q));
  const [projectId, planId] = sessionWork.split("|");
  const offerRoles = isStandingThread ? [] : liveRoles.filter((r) => r._id !== draft.role?.role_id && matches(r.name, r.handle));
  const fits = offerRoles.filter((r) => (projectId && r.scope?.project_ids?.includes(projectId)) || (planId && r.scope?.plan_ids?.includes(planId)));
  const suggested = (fits.length ? fits : offerRoles).slice(0, SUGGESTED_ROLES);
  const restRoles = offerRoles.filter((r) => !suggested.includes(r));
  const shownRoles = q || moreRoles ? [...suggested, ...restRoles] : suggested;
  const teammates = people.filter((m) => !draft.ownerIds.includes(m._id) && matches(memberName(m), m.email));
  const candidates: Candidate[] = [
    ...shownRoles.map((r) => ({ key: `r:${r._id}`, kind: "role" as const, role: r })),
    ...teammates.map((m) => ({ key: `p:${m._id}`, kind: "person" as const, person: personOf(m._id) })),
  ];
  const presenceOf = (id: string) => {
    const m = roster.find((x) => x._id === id);
    return m ? presenceLabel(memberPresenceVisual(m)) : null;
  };

  const add = (c: Candidate, drive = false) => setDraft((d) => (c.kind === "role" ? addRole(d, roleOwnerOf(c.role)) : addPerson(d, c.person._id, drive)));
  const makeDriver = (driver: SessionDriver) => setDraft((d) => ({ ...d, driver }));
  const leaveTo = (device: Device) => {
    setLeaving(false);
    if (meId) setDraft((d) => leave(d, meId, { device_id: device.device_id, is_remote: device.is_remote, label: deviceDisplayName(device) }));
  };

  const { added, removed, roleChanged, driverChanged, dirty, change, undo } = diffOwners(initial, draft);
  const save = () => {
    if (!dirty) return;
    if (draft.moveTo) void requestSessionMove(conversationId, draft.moveTo).catch(() => {});
    void owners.applyChange(change, { ownerIds: draft.ownerIds, role: draft.role, driver: draft.driver }, undo);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = candidates.length;
      if (n) setHi((h) => (e.key === "ArrowDown" ? (h + 1) % n : (h - 1 + n) % n));
      return;
    }
    if (e.key === "Enter") {
      const c = candidates[Math.min(hi, candidates.length - 1)];
      if (c) { e.preventDefault(); add(c); }
    }
  };

  // One chip per change; who drives rides the chip of the owner it names
  // when that owner is new.
  const driverName = (d: SessionDriver) => (d.kind === "role" ? draft.role?.name ?? "Role" : d.user_id === meId ? "You" : personOf(d.user_id).name);
  const drivesTag = (key: string) => (driverChanged && isDriver(draft.driver, key) ? " · driver" : "");
  const driverOnNew = !!draft.driver && driverChanged && (draft.driver.kind === "role" ? roleChanged : added.includes(draft.driver.user_id));
  const chips: string[] = [
    ...added.map((id) => `+ ${personOf(id).name}${drivesTag(`p:${id}`)}`),
    ...(roleChanged && draft.role ? [`+ ${draft.role.name}${drivesTag(`r:${draft.role.role_id}`)}`] : []),
    ...removed.map((id) => (id === meId ? "You leave" : `− ${personOf(id).name}`)),
    ...(roleChanged && initial.role ? [`− ${initial.role.name}`] : []),
    ...(driverChanged && draft.driver && !driverOnNew ? [`${driverName(draft.driver)} · driver`] : []),
    ...(draft.moveTo ? [`Move to ${draft.moveTo.label}`] : []),
  ];

  const ownerRow = (key: string, face: ReactNode, name: string, sub: string, onRemove: () => void, removeLabel: string, driverOf: SessionDriver | null, dim = false) => (
    <div key={key} className={ROW} data-owner-row={key} onMouseEnter={(e) => e.currentTarget.setAttribute("data-highlighted", "")} onMouseLeave={(e) => e.currentTarget.removeAttribute("data-highlighted")}>
      {face}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{name}</span>
        <span className={`truncate text-meta ${dim ? "text-sol-text-dim" : "text-sol-text-muted"}`}>{sub}</span>
      </span>
      {driverOf && <Button type="button" variant="outline" size="xs" className="own-mk" onClick={() => makeDriver(driverOf)}>Make driver</Button>}
      <button type="button" onClick={onRemove} title={removeLabel} aria-label={removeLabel} className={`${ICON_BTN} hover:text-sol-red hover:bg-sol-red/10`}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  return (
    <div onKeyDown={onKeyDown} data-owners-menu>
      <div className={LABEL}>Owners · whose inbox</div>
      {leaving && (
        <div className="mx-1 mb-1 rounded-md bg-sol-bg-highlight px-2 py-1.5" data-leave-box>
          <div className="text-meta text-sol-text-dim">Runs on your account. Move it to leave:</div>
          {moveTargets.length === 0 ? (
            <div className="py-1 text-meta text-sol-text-muted">No team machine to move it to</div>
          ) : moveTargets.map((d) => (
            <button key={d.device_id} type="button" onClick={() => leaveTo(d)} disabled={!d.online} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-ui text-sol-text hover:bg-sol-bg-alt disabled:opacity-50">
              <DeviceIcon d={d} className="w-3.5 h-3.5" />
              <span className="flex-1 truncate">{deviceDisplayName(d)}</span>
              <span className="text-meta text-sol-text-muted">{d.online ? "Move and leave" : "offline"}</span>
            </button>
          ))}
        </div>
      )}
      {draft.ownerIds.length === 0 && !draft.role && <div className="px-2 py-1 text-meta text-sol-text-dim">Nobody yet</div>}
      {draft.ownerIds.map((id) => {
        const p = id === meId ? { ...personOf(id), name: "You" } : personOf(id);
        const drives = isDriver(draft.driver, `p:${id}`);
        const runs = owners.runner?.user_id === id;
        const sub = [drives ? "Driver" : "Owner", runs ? (id === meId ? "runs on your account" : "runs it") : null, added.includes(id) ? "new" : null].filter(Boolean).join(" · ");
        const mine = id === meId;
        return ownerRow(`p:${id}`, <Face person={p} size={20} driver={drives} />, p.name, sub,
          mine && runsOnMine && !draft.moveTo ? () => setLeaving((v) => !v) : () => setDraft((d) => removePerson(d, id)),
          mine ? "Leave" : `Remove ${p.name}`,
          drives ? null : { kind: "user", user_id: id });
      })}
      {draft.role && (() => {
        const drives = draft.driver?.kind === "role";
        const sub = [drives ? "Driver" : "Paused", roleChanged ? "new" : null].filter(Boolean).join(" · ");
        return ownerRow(`r:${draft.role.role_id}`, <Face role={draft.role} size={20} driver={drives} paused={!drives} />, draft.role.name, sub, () => setDraft(removeRole), `Remove ${draft.role.name}`,
          drives ? null : { kind: "role", role_id: draft.role.role_id }, !drives);
      })()}
      {meId && isPerson(owners.currentUser) && !draft.ownerIds.includes(meId) && !removed.includes(meId) && (
        <button type="button" className={`${ROW} w-full text-sol-cyan`} onClick={() => add({ key: `p:${meId}`, kind: "person", person: personOf(meId) })}>
          <UserCheck className="w-3.5 h-3.5" /> Take ownership
        </button>
      )}
      <div className={SEP} />
      <label className="flex h-8 items-center gap-2 px-2 text-sol-text-dim">
        <Search className="w-3.5 h-3.5" />
        <input ref={searchRef} autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setHi(0); }} placeholder={isStandingThread ? "Add a teammate" : "Add a role or teammate"} aria-label="Add a role or teammate" autoComplete="off" className="min-w-0 flex-1 bg-transparent text-ui text-sol-text placeholder:text-sol-text-dim outline-none" />
      </label>
      <div className="max-h-[320px] overflow-y-auto" data-owner-candidates>
        {shownRoles.length > 0 && <div className={LABEL}>{q ? "Roles" : "Suggested roles"}</div>}
        {candidates.map((c, i) => {
          const isRole = c.kind === "role";
          const name = isRole ? c.role.name : c.person.name;
          const presence = isRole ? null : presenceOf(c.person._id);
          const firstTeammate = !isRole && (i === 0 || candidates[i - 1].kind === "role");
          return (
            <div key={c.key}>
              {firstTeammate && (
                <>
                  {!q && !moreRoles && restRoles.length > 0 && (
                    <button type="button" className={`${ROW} w-full text-sol-text-muted`} onClick={() => setMoreRoles(true)}>
                      <ChevronRight className="w-3.5 h-3.5" /> {restRoles.length} more {restRoles.length === 1 ? "role" : "roles"}
                    </button>
                  )}
                  <div className={LABEL}>Teammates</div>
                </>
              )}
              <div
                role="menuitemcheckbox"
                aria-checked={false}
                className={`${ROW} own-cand`}
                data-owner-candidate={c.key}
                {...(i === hi ? { "data-highlighted": "" } : {})}
                onMouseEnter={() => setHi(i)}
                onClick={() => add(c)}
              >
                {isRole ? <Face role={roleOwnerOf(c.role)} size={20} /> : <Face person={c.person} size={20} />}
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate">{name}</span>
                    {isRole && <span className="truncate font-mono text-meta text-sol-text-dim">@{c.role.handle}</span>}
                  </span>
                  {presence && (
                    <span className="inline-flex items-center gap-1.5 text-meta text-sol-text-dim">
                      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${presence === "Active" ? "bg-sol-green" : "bg-sol-text-dim"}`} />{presence}
                    </span>
                  )}
                </span>
                {!isRole && <Button type="button" variant="outline" size="xs" className="own-mk" onClick={(e) => { e.stopPropagation(); add(c, true); }}>Make driver</Button>}
                <button type="button" className={`${ICON_BTN} hover:text-sol-text own-plus`} title={`Add ${name}`} aria-label={`Add ${name}`} onClick={(e) => { e.stopPropagation(); add(c); }}>
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
        {!q && !moreRoles && restRoles.length > 0 && teammates.length === 0 && (
          <button type="button" className={`${ROW} w-full text-sol-text-muted`} onClick={() => setMoreRoles(true)}>
            <ChevronRight className="w-3.5 h-3.5" /> {restRoles.length} more {restRoles.length === 1 ? "role" : "roles"}
          </button>
        )}
        {candidates.length === 0 && <div className="px-2 py-2 text-meta text-sol-text-dim">{q ? "Nobody matches" : "Nobody else to add"}</div>}
      </div>
      <div className={SEP} />
      <div className="flex items-center gap-2 px-1 py-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {chips.length ? chips.map((c) => <span key={c} className="own-chip">{c}</span>) : <span className="px-1 text-meta text-sol-text-dim">No changes</span>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="button" size="sm" disabled={!dirty} onClick={save} data-owners-save>
          Save <KeyCap size="xs" tone="onAccent">{isMac ? "⌘↵" : "Ctrl ↵"}</KeyCap>
        </Button>
      </div>
    </div>
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
              <Face person={{ _id: m._id, name: memberName(m), image: m.image || m.github_avatar_url }} size={20} driver={on} />
              <span className="flex-1 truncate text-left">{memberName(m)}{m._id === meId ? " (you)" : ""}</span>
            </button>
          );
        })}
        {liveRoles.filter((r) => r._id !== seatRoleId).map((r) => {
          const on = orgRoleId === r._id;
          return (
            <button key={r._id} type="button" className={`${ROW} w-full ${on ? "font-medium" : ""}`} onClick={() => !on && pick({ kind: "role", role_id: r._id })}>
              <Face role={roleOwnerOf(r)} size={20} driver={on} />
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
