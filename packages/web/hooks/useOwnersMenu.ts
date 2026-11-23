"use client";

/**
 * The owners menu's model, shared by the web OwnersMenu and the phone's owners
 * sheet (mobile AssignmentChip), so both stage the same change by the same
 * rules and Save sends it in one store action (applySessionOwners).
 *
 * Until the first edit the menu follows the live owners; the first edit
 * freezes what it started from, which Save diffs against (lib/ownersDraft).
 * Each platform draws the rows and supplies what differs: the machines a
 * leave can move to, presence, keyboard focus.
 *
 * The highlight is the model's too: one ring of the owners, then the
 * candidates, with nothing highlighted on open and the first match while
 * searching. `activate` is what Enter does on it: a candidate is added, and
 * with `asDriver` (Shift+Enter) the row becomes the driver.
 *
 * MOBILE-SAFE like useOwners: bundled into the Expo app, so no DOM here.
 */

import { useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useOwnerCandidates, pickRoster, snapshotsOf, type OwnersApi, type OwnerRole, type SessionDriver } from "./useOwners";
import { addPeople, addPerson, addRole, diffOwners, driverKey, leave, removePerson, removeRole, type MoveTo, type OwnersDraft } from "../lib/ownersDraft";
import { useSessionRoleFacts } from "./useOwnersStoreEnv";
import { isPerson } from "@codecast/shared/team/memberKind";
import { applyOwnersChangeTo, leaveMovesFirst, leaveStands, type OwnersFacts } from "@codecast/shared/contracts/sessionOwners";
import type { OrgRole } from "../components/org/orgTypes";

const SUGGESTED_ROLES = 3;

export type OwnerPerson = { _id: string; name: string; image?: string };
export type OwnerCandidate = { key: string; kind: "person"; person: OwnerPerson } | { key: string; kind: "role"; role: OrgRole };

/** One current owner as the menu lists it. `onRemove` null: it cannot go
 *  (the sole owner of an agent-run session), and `refusal` says why when its
 *  remove is pressed (`refuse`); `makeDriver` null: it drives. */
export type OwnerMenuRow = {
  key: string;
  person?: OwnerPerson;
  role?: OwnerRole;
  name: string;
  sub: string;
  drives: boolean;
  paused: boolean;
  mine: boolean;
  onRemove: (() => void) | null;
  removeLabel: string;
  refusal: string | null;
  makeDriver: SessionDriver | null;
};

export const memberName = (m: any): string => m?.name || m?.email?.split("@")[0] || "Teammate";
export const roleOwnerOf = (r: OrgRole): OwnerRole => ({ role_id: r._id, short_id: r.short_id, handle: r.handle, name: r.name, avatar: (r as any).avatar ?? null });
export const isDriverKey = (d: SessionDriver | null, key: string) => driverKey(d) === key;

/** The current view (people, role, driver) the segment and the menu start from. */
export function useOwnersView(owners: OwnersApi) {
  const { ownerList, displayFor, currentUser, role, driver } = owners;
  const meId: string | undefined = currentUser?._id?.toString?.();
  const people: OwnerPerson[] = ownerList.map((id) => {
    if (id === meId && currentUser) return { _id: id, name: memberName(currentUser), image: currentUser.image || currentUser.github_avatar_url };
    const d = displayFor(id);
    return { _id: id, name: d.name, image: d.image };
  });
  return { meId, people, role, driver };
}

export function useOwnersMenu(conversationId: string, owners: OwnersApi) {
  // The session team's roster, subscribed for the menu's lifetime alone.
  const serverRoster = useOwnerCandidates(conversationId, owners.currentUser);
  const { liveRoles, isStandingThread } = useSessionRoleFacts(conversationId);
  const sessionWork = useInboxStore((s) => {
    const row = (s.sessions as any)?.[s.resolveLiveSessionId(conversationId)] ?? (s.conversations as any)?.[conversationId];
    return `${row?.project_id ?? ""}|${row?.active_plan?._id ?? ""}|${row?.active_plan?.title ?? ""}`;
  });
  const projectTitle = useInboxStore((s) => {
    const id = sessionWork.split("|")[0];
    return id ? ((s as any).projects?.[id]?.title as string | undefined) ?? null : null;
  });
  const { meId, people: initialPeople, role: initialRole, driver: initialDriver } = useOwnersView(owners);
  const runsOnMine = !!meId && owners.runner?.user_id === meId;

  const live: OwnersDraft = { ownerIds: initialPeople.map((p) => p._id), role: initialRole, driver: initialDriver, moveTo: null };
  const [edit, setEdit] = useState<{ initial: OwnersDraft; draft: OwnersDraft } | null>(null);
  const initial = edit?.initial ?? live;
  const draft = edit?.draft ?? live;
  const setDraft = (f: (d: OwnersDraft) => OwnersDraft) => setEdit((e) => ({ initial: e?.initial ?? live, draft: f(e?.draft ?? live) }));
  const [query, setQueryRaw] = useState("");
  // The highlighted row of the ring (owners, then candidates); -1 is none.
  const [hi, setHi] = useState(-1);
  // Why the last pressed remove was refused, until the next add.
  const [notice, setNotice] = useState<string | null>(null);
  const [moreRoles, setMoreRoles] = useState(false);
  // The machines a leave from your own account can move it to are showing.
  const [leaving, setLeaving] = useState(false);

  const people = pickRoster(serverRoster, owners.selectable).filter(isPerson);
  const personById = new Map<string, OwnerPerson>(initialPeople.map((p) => [p._id, p]));
  for (const p of people) personById.set(p._id, { _id: p._id, name: memberName(p), image: p.image || p.github_avatar_url });
  const personOf = (id: string): OwnerPerson => personById.get(id) ?? { _id: id, name: owners.displayFor(id).name };

  const q = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q));
  const [projectId, planId, planTitleRaw] = sessionWork.split("|");
  const planTitle = planTitleRaw || null;
  const offerRoles = isStandingThread ? [] : liveRoles.filter((r) => r._id !== draft.role?.role_id && matches(r.name, r.handle));
  // Why a role is suggested: its area holds this session's project or plan.
  // The fallback roles (none fits) carry no reason.
  const reasonOf = (r: OrgRole): string | null =>
    projectId && r.scope?.project_ids?.includes(projectId) ? `This session is in ${projectTitle ?? "its project"}`
      : planId && r.scope?.plan_ids?.includes(planId) ? `This session works on ${planTitle ?? "its plan"}`
        : null;
  const fits = offerRoles.filter((r) => reasonOf(r));
  const suggested = (fits.length ? fits : offerRoles).slice(0, SUGGESTED_ROLES);
  const restRoles = offerRoles.filter((r) => !suggested.includes(r));
  const shownRoles = q || moreRoles ? [...suggested, ...restRoles] : suggested;
  // Everyone on the session's team not yet an owner or pending, whatever the search shows.
  const unselected = people.filter((m) => !draft.ownerIds.includes(m._id));
  const teammates = unselected.filter((m) => matches(memberName(m), m.email));
  const candidates: OwnerCandidate[] = [
    ...shownRoles.map((r) => ({ key: `r:${r._id}`, kind: "role" as const, role: r })),
    ...teammates.map((m) => ({ key: `p:${m._id}`, kind: "person" as const, person: personOf(m._id) })),
  ];

  const add = (c: OwnerCandidate, drive = false) => {
    setNotice(null);
    setDraft((d) => (c.kind === "role" ? addRole(d, roleOwnerOf(c.role)) : addPerson(d, c.person._id, drive)));
  };
  const makeDriver = (driver: SessionDriver) => setDraft((d) => ({ ...d, driver }));
  const selectAllTeammates = () => setDraft((d) => addPeople(d, unselected.map((m) => m._id)));
  const leaveTo = (moveTo: MoveTo) => {
    setLeaving(false);
    if (meId) setDraft((d) => leave(d, meId, moveTo));
  };

  // Leave, the move with it, and everything else land as one change, so a
  // refusal (the move or the leave) rolls the whole Save back.
  const diff = diffOwners(initial, draft, { meId, initialDriverUserId: owners.session.driver_user_id, snapshots: snapshotsOf(owners.row, initial.ownerIds), canRejoin: !!owners.row?.team_access });
  const { added, removed, leaving: iLeave, roleChanged, driverChanged, dirty, change, inverse } = diff;
  /** Save: true when it sent something (the menu then closes). */
  const save = () => {
    if (!dirty) return false;
    owners.applyChange(change, inverse);
    return true;
  };

  // One chip per change; who drives rides the chip of the owner it names
  // when that owner is new.
  const driverName = (d: SessionDriver) => (d.kind === "role" ? draft.role?.name ?? "Role" : d.user_id === meId ? "You" : personOf(d.user_id).name);
  const drivesTag = (key: string) => (driverChanged && isDriverKey(draft.driver, key) ? " · driver" : "");
  const driverOnNew = !!draft.driver && driverChanged && (draft.driver.kind === "role" ? roleChanged : added.includes(draft.driver.user_id));
  const chips: string[] = [
    // A long multi-select reads as one count, not a wall of chips.
    ...(added.length > 3 ? [`+ ${added.length} people`] : added.map((id) => `+ ${personOf(id).name}${drivesTag(`p:${id}`)}`)),
    ...(roleChanged && draft.role ? [`+ ${draft.role.name}${drivesTag(`r:${draft.role.role_id}`)}`] : []),
    ...removed.map((id) => `− ${personOf(id).name}`),
    ...(iLeave ? ["You leave"] : []),
    ...(roleChanged && initial.role ? [`− ${initial.role.name}`] : []),
    ...(driverChanged && draft.driver && !driverOnNew ? [`${driverName(draft.driver)} · driver`] : []),
    ...(draft.moveTo ? [`Move to ${draft.moveTo.label}`] : []),
  ];

  // A teammate who only sees the session reads the owners: no remove, no Make
  // driver, no candidates (the server refuses the rest anyway).
  const readOnly = !owners.canEdit;
  // The staged owners as the shared leave rules read them (the server's own).
  const facts: OwnersFacts = {
    rows: draft.ownerIds.map((user_id, i) => ({ user_id, added_at: i })),
    author_id: owners.row?.author_id ?? null,
    runner_id: owners.runner?.user_id ?? owners.session.runner_id ?? "",
    bots: owners.row?.bots ?? [],
    role_id: draft.role?.role_id ?? null,
    role_started: !!owners.row?.role_started,
    standing_role_id: null,
    driver_user_id: draft.driver?.kind === "user" ? draft.driver.user_id : null,
    primary_id: null,
  };
  // Leaving a session on your own account first picks a machine to move it
  // to, unless a role started it (leaveMovesFirst).
  const movesFirst = !!meId && leaveMovesFirst(facts, meId);
  // You cannot leave when nobody would be left to own it: an agent box runs
  // it and no role started it (leaveStands; a person who runs it takes it).
  const soleOwner = !!meId && draft.ownerIds.includes(meId) && !movesFirst && !leaveStands(applyOwnersChangeTo(facts, { leave: {} }, { actor: meId, now: draft.ownerIds.length }), meId);

  const rows: OwnerMenuRow[] = draft.ownerIds.map((id) => {
    const mine = id === meId;
    const p = mine ? { ...personOf(id), name: "You" } : personOf(id);
    const drives = isDriverKey(draft.driver, `p:${id}`);
    const runs = owners.runner?.user_id === id;
    const sub = [drives ? "Driver" : "Owner", runs ? (mine ? "runs on your account" : "runs it") : null, added.includes(id) ? "new" : null].filter(Boolean).join(" · ");
    return {
      key: `p:${id}`, person: p, name: p.name, sub, drives, paused: false, mine,
      onRemove: mine && soleOwner ? null : mine && movesFirst && !draft.moveTo ? () => setLeaving((v) => !v) : () => setDraft((d) => removePerson(d, id)),
      removeLabel: mine ? (soleOwner ? "You are its only owner: add someone before you leave" : "Leave") : `Remove ${p.name}`,
      refusal: mine && soleOwner ? "Add an owner before you leave" : null,
      makeDriver: drives ? null : { kind: "user", user_id: id },
    };
  });
  if (draft.role) {
    const drives = draft.driver?.kind === "role";
    rows.push({
      key: `r:${draft.role.role_id}`, role: draft.role, name: draft.role.name,
      sub: [drives ? "Driver" : "Paused", roleChanged ? "new" : null].filter(Boolean).join(" · "),
      drives, paused: !drives, mine: false,
      onRemove: () => setDraft(removeRole), removeLabel: `Remove ${draft.role.name}`, refusal: null,
      makeDriver: drives ? null : { kind: "role", role_id: draft.role.role_id },
    });
  }

  // "Take ownership": offered to a person who is not an owner. A claim by a
  // viewer who may not edit is one press, which the server allows anyone who
  // sees the session; an editor stages it with the rest.
  const canTakeOwnership = !!meId && isPerson(owners.currentUser) && !draft.ownerIds.includes(meId) && !iLeave;
  /** True when the claim was sent at once (the menu then closes). */
  const takeOwnership = () => {
    if (!meId) return false;
    if (readOnly) { owners.applyChange({ add: [meId] }, { remove: [meId] }); return true; }
    add({ key: `p:${meId}`, kind: "person", person: personOf(meId) });
    return false;
  };

  // The keyboard's ring: the owners as listed, then the candidates.
  const ring = rows.length + candidates.length;
  // A highlight past the end lands on the last candidate, never back on an
  // owner row: with no candidate (a search with no match) nothing is
  // highlighted, so Shift+Enter cannot hand an owner the wheel unseen.
  const highlighted = hi < ring ? hi : candidates.length ? ring - 1 : -1;
  const move = (step: 1 | -1) => {
    if (ring) setHi((h) => (step > 0 ? (Math.min(h, ring - 1) + 1) % ring : (Math.max(h, 0) - 1 + ring) % ring));
  };
  /** Enter on the highlighted row: add a candidate (as driver with
   *  `asDriver`), or with `asDriver` make an owner the driver. */
  const activate = (asDriver: boolean) => {
    if (highlighted < 0) return false;
    if (highlighted < rows.length) {
      const target = asDriver && !readOnly ? rows[highlighted].makeDriver : null;
      if (target) makeDriver(target);
      return !!target;
    }
    add(candidates[highlighted - rows.length], asDriver);
    return true;
  };
  // Typing highlights the first match; clearing the search highlights nothing.
  const setQuery = (text: string) => {
    setQueryRaw(text);
    setHi(text.trim() ? rows.length : -1);
  };
  const refuse = (row: OwnerMenuRow) => setNotice(row.refusal);

  return {
    meId, runsOnMine, highlighted, setHighlighted: setHi, move, activate, notice, refuse, draft, initial, rows, readOnly, soleOwner, isStandingThread,
    query, setQuery, q, moreRoles, setMoreRoles, leaving, setLeaving,
    reasonOf, shownRoles, restRoles, unselected, teammates, candidates,
    add, makeDriver, selectAllTeammates, leaveTo, canTakeOwnership, takeOwnership,
    diff, chips, dirty, save,
  };
}

export type OwnersMenuModel = ReturnType<typeof useOwnersMenu>;
