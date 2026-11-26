"use client";

/**
 * The owners menu's model under the session_owners model (components/OwnersMenu):
 * the owner rows, the candidates (suggested roles with a reason, the rest of
 * the roles, teammates), the staged change and its chips, the keyboard's
 * highlight, and Save, which sends the whole change in one store action
 * (applySessionOwners). Until the first edit the menu follows the live
 * owners; the first edit freezes what it started from, which Save diffs
 * against (lib/ownersDraft).
 *
 * The highlight is one ring: the owner rows, then the candidates; nothing is
 * highlighted on open, and typing highlights the first match. Enter adds the
 * highlighted candidate.
 *
 * MOBILE-SAFE: no DOM.
 */

import { useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useOwnerCandidates, pickRoster } from "./useOwners";
import { useSessionRoleFacts } from "./useOwnersStoreEnv";
import { isPerson } from "@codecast/shared/team/memberKind";
import { teamMembersOf } from "../lib/activeTeam";
import { addPeople, addPerson, diffOwners, releaseParent, removePerson, removeRole, setRole, type OwnersDraft } from "../lib/ownersDraft";
import { ownersChangeRefusalIn, type OwnerRestoreRow, type SessionOwnersChange } from "../store/sessionOwnersSlice";
import { memberName, roleOwnerOf, type OwnerPerson, type OwnerRoleFace, type SessionOwnersView } from "./useSessionOwners";
import type { OrgRole } from "../components/org/orgTypes";

const SUGGESTED_ROLES = 3;

export type OwnerCandidate =
  | { key: string; kind: "person"; person: OwnerPerson; member: any }
  | { key: string; kind: "role"; role: OrgRole };

/** One owner row as the menu lists it. */
export type OwnerMenuRow = {
  key: string;
  kind: "person" | "role" | "session";
  person?: OwnerPerson;
  role?: OwnerRoleFace;
  name: string;
  sub: string;
  mine: boolean;
  /** Null: it cannot go (the only owner). */
  onRemove: (() => void) | null;
  removeLabel: string;
};

export function useOwnersMenu(conversationId: string, view: SessionOwnersView, opts: { open: boolean }) {
  const currentUser = useInboxStore((s) => s.currentUser);
  // The session team's roster and the org's roles, for the menu's lifetime alone.
  const serverRoster = useOwnerCandidates(conversationId, currentUser, opts.open);
  const roster = useInboxStore(teamMembersOf) as any[];
  const { liveRoles, isStandingThread } = useSessionRoleFacts(conversationId);
  const sessionWork = useInboxStore((s: any) => {
    const row = s.sessions?.[s.resolveLiveSessionId(conversationId)] ?? s.conversations?.[conversationId];
    return `${row?.project_id ?? ""}|${row?.active_plan?._id ?? ""}|${row?.active_plan?.title ?? ""}`;
  });
  const [projectId, planId, planTitleRaw] = sessionWork.split("|");
  const projectTitle = useInboxStore((s: any) => (projectId ? ((s.projects?.[projectId]?.title as string | undefined) ?? null) : null));

  const live = view.draft;
  const [edit, setEdit] = useState<{ initial: OwnersDraft; draft: OwnersDraft } | null>(null);
  const initial = edit?.initial ?? live;
  const draft = edit?.draft ?? live;
  const setDraft = (f: (d: OwnersDraft) => OwnersDraft) => setEdit((e) => ({ initial: e?.initial ?? live, draft: f(e?.draft ?? live) }));
  const [query, setQueryRaw] = useState("");
  const [hi, setHi] = useState(-1);
  const [moreRoles, setMoreRoles] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const meId = view.meId;
  const readOnly = !view.canEdit;

  const people = pickRoster(serverRoster, roster).filter(isPerson);
  const personById = new Map<string, OwnerPerson>();
  for (const p of people) personById.set(String(p._id), { _id: String(p._id), name: memberName(p), image: p.image || p.github_avatar_url || undefined });
  const personOf = (id: string): OwnerPerson => (id === meId ? view.personOf(id) : personById.get(id) ?? view.personOf(id));

  const q = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q));
  const offerRoles = isStandingThread ? [] : liveRoles.filter((r) => r._id !== draft.role?.role_id && matches(r.name, r.handle));
  const planTitle = planTitleRaw || null;
  // Why a role is suggested: its area holds this session's project or plan.
  const reasonOf = (r: OrgRole): string | null =>
    projectId && r.scope?.project_ids?.includes(projectId) ? `This session is in ${projectTitle ?? "its project"}`
      : planId && r.scope?.plan_ids?.includes(planId) ? `This session works on ${planTitle ?? "its plan"}`
        : null;
  const fits = offerRoles.filter((r) => reasonOf(r));
  const suggested = (fits.length ? fits : offerRoles).slice(0, SUGGESTED_ROLES);
  const restRoles = offerRoles.filter((r) => !suggested.includes(r));
  const shownRoles = q || moreRoles ? [...suggested, ...restRoles] : suggested;
  // While you are staged to leave you are not a candidate: listing you (and
  // Select all taking you) would quietly undo the leave. Remove the × instead.
  const leaving = !!meId && initial.people.includes(meId) && !draft.people.includes(meId);
  const unselected = people.filter((m) => !draft.people.includes(String(m._id)) && !(leaving && String(m._id) === meId));
  const teammates = unselected.filter((m) => matches(memberName(m), m.email));
  // Teammates first: sharing with a person is the usual move, a role the rarer one.
  const candidates: OwnerCandidate[] = readOnly ? [] : [
    ...teammates.map((m) => ({ key: `p:${m._id}`, kind: "person" as const, person: personOf(String(m._id)), member: m })),
    ...shownRoles.map((r) => ({ key: `r:${r._id}`, kind: "role" as const, role: r })),
  ];

  const add = (c: OwnerCandidate) => {
    setNotice(null);
    // Putting back the role whose seat started it puts its seat back too
    // (removing that role let both go).
    const seatBack = c.kind === "role" && !!initial.parent && view.parent?.seatRoleId === c.role._id;
    setDraft((d) => (c.kind === "role" ? { ...setRole(d, roleOwnerOf(c.role)), ...(seatBack ? { parent: initial.parent } : {}) } : addPerson(d, c.person._id)));
  };
  const selectAllTeammates = () => setDraft((d) => addPeople(d, unselected.map((m) => String(m._id))));

  // Only the people who hold an owner row (people_ids); people_info is detail.
  const snapshots: OwnerRestoreRow[] = (view.read?.people_ids ?? []).map((id) => view.read!.people_info[id])
    .filter((p): p is NonNullable<typeof p> => !!p?.added_by && p.added_at != null)
    .map((p) => ({ user_id: String(p.user_id), added_by: String(p.added_by), added_at: p.added_at!, ...(p.seen_at != null ? { seen_at: p.seen_at } : {}), ...(p.note ? { note: p.note } : {}) }));
  const diff = diffOwners(initial, draft, { meId: meId ?? undefined, snapshots, meRuns: !!meId && view.runnerId === meId });

  // A parent that is the role's own standing session is the same agent: the
  // role's row stands for both, and removing it releases both.
  const parentIsRole = !!draft.parent && !!draft.role && view.parent?.seatRoleId === draft.role.role_id;
  // The only owner left cannot go: the session must keep one.
  const ownerCount = draft.people.length + (draft.role ? 1 : 0) + (draft.parent && !parentIsRole ? 1 : 0);
  const solo = ownerCount <= 1;
  const rows: OwnerMenuRow[] = draft.people.map((id) => {
    const mine = id === meId;
    const p = personOf(id);
    const fresh = diff.added.includes(id);
    return {
      key: `p:${id}`, kind: "person", person: p, name: mine ? "You" : p.name,
      sub: fresh ? "Owner · new" : "Owner", mine,
      onRemove: solo ? null : () => setDraft((d) => removePerson(d, id)),
      removeLabel: solo ? "The only owner" : mine ? "Leave" : `Remove ${p.name}`,
    };
  });
  if (draft.role) {
    const r = draft.role as OwnerRoleFace;
    rows.push({
      key: `r:${r.role_id}`, kind: "role", role: r, name: r.name,
      sub: diff.roleAdded ? "Role · answers for you · new" : "Role · answers for you", mine: false,
      onRemove: solo ? null : () => setDraft((d) => (parentIsRole ? releaseParent(removeRole(d)) : removeRole(d))),
      removeLabel: solo ? "The only owner" : `Remove ${r.name}`,
    });
  }
  if (draft.parent && !parentIsRole) {
    rows.push({
      key: `s:${draft.parent}`, kind: "session", name: view.parent?.title ?? "Session it works for",
      sub: "Session it works for", mine: false,
      onRemove: solo ? null : () => setDraft(releaseParent), removeLabel: solo ? "The only owner" : "Remove the session it works for",
    });
  }

  const short = (id: string) => (id === meId ? "You" : personOf(id).name.split(/\s+/)[0]);
  const chips: Array<{ key: string; label: string; face: { person?: OwnerPerson; role?: OwnerRoleFace; session?: boolean }; gone?: boolean }> = [
    ...diff.added.map((id) => ({ key: `+${id}`, label: `+ ${short(id)}`, face: { person: personOf(id) } })),
    ...(diff.roleAdded ? [{ key: "+role", label: `+ ${diff.roleAdded.name}`, face: { role: diff.roleAdded as OwnerRoleFace } }] : []),
    ...diff.removed.map((id) => ({ key: `-${id}`, label: id === meId ? "You leave" : short(id), face: { person: personOf(id) }, gone: true })),
    ...(diff.roleRemoved ? [{ key: "-role", label: diff.roleRemoved.name, face: { role: diff.roleRemoved as OwnerRoleFace }, gone: true }] : []),
    ...(diff.parentReleased && !(diff.roleRemoved && view.parent?.seatRoleId === diff.roleRemoved.role_id) ? [{ key: "-parent", label: view.parent?.title ?? "Its session", face: { session: true }, gone: true }] : []),
  ];

  /** Save: true when it sent something (the menu then closes). A change the
   *  shared rule refuses stays staged, with the reason. */
  const save = (send: (change: SessionOwnersChange, inverse: SessionOwnersChange | null) => void) => {
    if (!diff.dirty) return false;
    const refusal = ownersChangeRefusalIn(useInboxStore.getState() as never, conversationId, diff.change);
    if (refusal) { setNotice(refusal); return false; }
    send(diff.change, diff.inverse);
    return true;
  };

  const ring = rows.length + candidates.length;
  const highlighted = hi < ring ? hi : candidates.length ? ring - 1 : -1;
  const move = (step: 1 | -1) => {
    if (ring) setHi((h) => (step > 0 ? (Math.min(h, ring - 1) + 1) % ring : (Math.max(h, 0) - 1 + ring) % ring));
  };
  /** Enter on the highlight: adds a candidate. True when it did. */
  const activate = () => {
    if (highlighted < rows.length) return false;
    const c = candidates[highlighted - rows.length];
    if (!c) return false;
    add(c);
    return true;
  };
  const setQuery = (text: string) => {
    setQueryRaw(text);
    setHi(text.trim() ? rows.length : -1);
  };

  return {
    meId, readOnly, rows, candidates, shownRoles, restRoles, teammates, unselected, moreRoles, setMoreRoles,
    query, setQuery, q, reasonOf, add, selectAllTeammates, highlighted, setHighlighted: setHi, move, activate,
    diff, dirty: diff.dirty, chips, notice, save, isStandingThread,
  };
}

export type OwnersMenuModel = ReturnType<typeof useOwnersMenu>;
