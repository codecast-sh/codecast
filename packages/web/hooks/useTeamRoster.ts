// Identity view of the team roster.
//
// `s.teamMembers` is an ARRAY that re-pushes on teammates' presence heartbeats
// and recent-session counters, so any component subscribing to it whole
// re-renders several times a minute — multiplied by every session card, avatar
// and sender chip on screen. Almost none of them draw anything but identity
// (who is this member, what do they look like). This module projects the
// roster to those fields under a signature, so a heartbeat costs nothing and a
// rename/avatar change still re-renders.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";

export type RosterIdentity = {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
  github_avatar_url?: string;
  github_username?: string;
  is_bot?: boolean;
};

function identityLine(m: any): string {
  return `${m._id}|${m.name ?? ""}|${m.email ?? ""}|${m.image ?? ""}|${m.github_avatar_url ?? ""}|${m.github_username ?? ""}|${m.is_bot ? 1 : 0}\n`;
}

function toIdentity(m: any): RosterIdentity {
  return {
    _id: String(m._id),
    name: m.name ?? undefined,
    email: m.email ?? undefined,
    image: m.image ?? undefined,
    github_avatar_url: m.github_avatar_url ?? undefined,
    github_username: m.github_username ?? undefined,
    is_bot: !!m.is_bot,
  };
}

let _membersRef: unknown;
let _membersSig = "";
/** Signature of the roster's identity fields, memoized on the array ref. */
export function memberListSig(members: any[] | null | undefined): string {
  if (members === _membersRef) return _membersSig;
  let out = "";
  for (const m of members ?? []) {
    if (m?._id) out += identityLine(m);
  }
  _membersRef = members;
  _membersSig = out;
  return out;
}

let _identityRef: unknown;
let _identitySig = "";
let _identityList: RosterIdentity[] = [];
/** The roster projected to identity fields; the array ref is stable across
 *  heartbeat pushes and only changes when an identity field changes. */
export function rosterIdentity(members: any[] | null | undefined): RosterIdentity[] {
  if (members === _identityRef) return _identityList;
  const sig = memberListSig(members);
  _identityRef = members;
  if (sig === _identitySig) return _identityList;
  _identitySig = sig;
  _identityList = (members ?? []).filter((m) => m?._id).map(toIdentity);
  return _identityList;
}

/** Subscribe to roster identity only (never presence/counters). */
export function useTeamRosterIdentity(): RosterIdentity[] {
  const sig = useInboxStore((s) => memberListSig(s.teamMembers));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the churny array
  return useMemo(() => rosterIdentity(useInboxStore.getState().teamMembers), [sig]);
}

/** The viewer projected to the same identity fields. `s.currentUser` is the
 *  whole user doc, which churns on daemon heartbeats; this wakes only when
 *  who-they-are changes. */
export function useViewerIdentity(): RosterIdentity | null {
  const sig = useInboxStore((s) => (s.currentUser?._id ? identityLine(s.currentUser) : ""));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the churny doc
  return useMemo(() => {
    const u = useInboxStore.getState().currentUser;
    return u?._id ? toIdentity(u) : null;
  }, [sig]);
}
